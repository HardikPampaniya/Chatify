const mongoose = require("mongoose");
const User = require("../models/User");
const Conversation = require("../models/Conversation");
const FriendRequest = require("../models/FriendRequest");

const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const pairQuery = (first, second) => ({
    $or: [
        { requester: first, recipient: second },
        { requester: second, recipient: first }
    ]
});

const emitRequestUpdate = (req, ...userIds) => {
    const io = req.app.get("io");
    if (!io) return;
    [...new Set(userIds.map(id => id.toString()))].forEach(id => {
        io.to(`user:${id}`).emit("friend_requests:updated");
    });
};

const getUsers = async (req, res) => {
    const query = String(req.query.q || "").trim().slice(0, 30);
    if (query.length < 2) return res.json({ users: [] });

    const users = await User.find({
        _id: { $ne: req.user._id },
        username: { $regex: `^${escapeRegex(query)}`, $options: "i" }
    })
        .select("username")
        .sort({ username: 1 })
        .limit(20)
        .lean();

    if (!users.length) return res.json({ users: [] });

    const userIds = users.map(user => user._id);
    const [requests, conversations] = await Promise.all([
        FriendRequest.find({
            $or: [
                { requester: req.user._id, recipient: { $in: userIds } },
                { recipient: req.user._id, requester: { $in: userIds } }
            ]
        }).select("requester recipient status").lean(),
        Conversation.find({
            $and: [
                { participants: req.user._id },
                { participants: { $in: userIds } }
            ]
        }).select("participants").lean()
    ]);

    const relationships = new Map();
    for (const request of requests) {
        const isRequester = request.requester.toString() === req.user._id.toString();
        const otherId = (isRequester ? request.recipient : request.requester).toString();
        const relationship = request.status === "accepted"
            ? { status: "friend" }
            : request.status === "pending"
                ? { status: isRequester ? "outgoing" : "incoming", requestId: request._id }
                : null;
        if (relationship) relationships.set(otherId, relationship);
    }
    for (const conversation of conversations) {
        const other = conversation.participants.find(id => id.toString() !== req.user._id.toString());
        if (other) relationships.set(other.toString(), { status: "friend" });
    }

    res.json({
        users: users.map(user => ({
            ...user,
            relationship: relationships.get(user._id.toString()) || { status: "none" }
        }))
    });
};

const getFriendRequests = async (req, res) => {
    const [incoming, outgoing] = await Promise.all([
        FriendRequest.find({ recipient: req.user._id, status: "pending" })
            .populate("requester", "username")
            .sort({ createdAt: -1 }),
        FriendRequest.find({ requester: req.user._id, status: "pending" })
            .populate("recipient", "username")
            .sort({ createdAt: -1 })
    ]);

    res.json({
        incoming: incoming.map(request => ({ _id: request._id, user: request.requester, createdAt: request.createdAt })),
        outgoing: outgoing.map(request => ({ _id: request._id, user: request.recipient, createdAt: request.createdAt }))
    });
};

const sendFriendRequest = async (req, res) => {
    const targetId = req.params.userId;
    if (!mongoose.isValidObjectId(targetId)) return res.status(400).json({ message: "Invalid user ID" });
    if (targetId === req.user._id.toString()) return res.status(400).json({ message: "You cannot add yourself" });

    const recipient = await User.findById(targetId).select("_id username");
    if (!recipient) return res.status(404).json({ message: "User not found" });

    const conversation = await Conversation.findOne({ participants: { $all: [req.user._id, recipient._id], $size: 2 } });
    if (conversation) return res.json({ relationship: "friend", message: "You can already chat with this person" });

    const accepted = await FriendRequest.findOne({ ...pairQuery(req.user._id, recipient._id), status: "accepted" });
    if (accepted) return res.json({ relationship: "friend", message: "You are already connected" });

    const incoming = await FriendRequest.findOne({ requester: recipient._id, recipient: req.user._id, status: "pending" });
    if (incoming) return res.status(409).json({ message: "This person already sent you a request. Accept it from your requests." });

    try {
        const prior = await FriendRequest.findOne({ requester: req.user._id, recipient: recipient._id });
        let request;
        if (prior) {
            if (prior.status === "pending") return res.status(409).json({ message: "Friend request already sent" });
            prior.status = "pending";
            prior.respondedAt = null;
            request = await prior.save();
        } else {
            request = await FriendRequest.create({ requester: req.user._id, recipient: recipient._id });
        }

        emitRequestUpdate(req, recipient._id);
        res.status(201).json({ relationship: "outgoing", requestId: request._id });
    } catch (error) {
        if (error.code !== 11000) throw error;
        const existing = await FriendRequest.findOne({ requester: req.user._id, recipient: recipient._id });
        if (existing?.status === "pending") return res.status(409).json({ message: "Friend request already sent" });
        throw error;
    }
};

const ensureConversation = async (firstId, secondId) => {
    let conversation = await Conversation.findOne({ participants: { $all: [firstId, secondId], $size: 2 } });
    if (!conversation) {
        try {
            conversation = await Conversation.create({ participants: [firstId, secondId] });
        } catch (error) {
            if (error.code !== 11000) throw error;
            conversation = await Conversation.findOne({ participants: { $all: [firstId, secondId], $size: 2 } });
            if (!conversation) throw error;
        }
    }
    return conversation;
};

const acceptFriendRequest = async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.requestId)) return res.status(400).json({ message: "Invalid request ID" });
    const request = await FriendRequest.findOneAndUpdate(
        { _id: req.params.requestId, recipient: req.user._id, status: "pending" },
        { $set: { status: "accepted", respondedAt: new Date() } },
        { new: true }
    );
    if (!request) return res.status(404).json({ message: "Pending friend request not found" });

    await ensureConversation(request.requester, request.recipient);
    emitRequestUpdate(req, request.requester, request.recipient);
    res.json({ message: "Friend request accepted" });
};

const rejectFriendRequest = async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.requestId)) return res.status(400).json({ message: "Invalid request ID" });
    const request = await FriendRequest.findOneAndUpdate(
        { _id: req.params.requestId, recipient: req.user._id, status: "pending" },
        { $set: { status: "rejected", respondedAt: new Date() } },
        { new: true }
    );
    if (!request) return res.status(404).json({ message: "Pending friend request not found" });

    emitRequestUpdate(req, request.requester);
    res.json({ message: "Friend request declined" });
};

const cancelFriendRequest = async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.requestId)) return res.status(400).json({ message: "Invalid request ID" });
    const request = await FriendRequest.findOneAndDelete({
        _id: req.params.requestId,
        requester: req.user._id,
        status: "pending"
    });
    if (request) emitRequestUpdate(req, request.recipient);
    res.status(204).end();
};

module.exports = {
    getUsers,
    getFriendRequests,
    sendFriendRequest,
    acceptFriendRequest,
    rejectFriendRequest,
    cancelFriendRequest
};
