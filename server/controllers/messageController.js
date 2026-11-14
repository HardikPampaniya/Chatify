const mongoose = require("mongoose");
const Conversation = require("../models/Conversation");
const Message = require("../models/Message");
const { isParticipant } = require("./conversationController");
const { deleteMedia } = require("../services/objectStorage");

const getMessages = async (req, res) => {
    const conversationId = req.params.conversationId;

    if (!mongoose.isValidObjectId(conversationId)) {
        return res.status(400).json({ message: "Invalid conversation ID" });
    }

    const conversation = await Conversation.findById(conversationId);
    if (!conversation) {
        return res.status(404).json({ message: "Conversation not found" });
    }

    if (!isParticipant(conversation, req.user._id)) {
        return res.status(403).json({ message: "Access denied" });
    }

    const messages = await Message.find({
        conversation: conversationId,
        deletedFor: { $ne: req.user._id }
    })
        .populate("sender", "username")
        .populate("receiver", "username")
        .sort({ createdAt: -1 })
        .limit(200);

    res.json({ messages: messages.reverse() });
};

const createTextMessage = async (req, res) => {
    const conversationId = req.params.conversationId;
    const text = String(req.body.text || "").trim();

    if (!mongoose.isValidObjectId(conversationId)) {
        return res.status(400).json({ message: "Invalid conversation ID" });
    }

    if (!text || text.length > 5000) {
        return res.status(400).json({ message: "Message must be 1 to 5000 characters" });
    }

    const conversation = await Conversation.findById(conversationId);
    if (!conversation || !isParticipant(conversation, req.user._id)) {
        return res.status(403).json({ message: "Access denied" });
    }

    const receiver = conversation.participants.find(
        id => id.toString() !== req.user._id.toString()
    );

    let message;
    const previousLastMessage = conversation.lastMessage;
    try {
        message = await Message.create({
            conversation: conversation._id,
            sender: req.user._id,
            receiver,
            type: "text",
            text
        });

        conversation.lastMessage = message._id;
        await conversation.save();
    } catch (error) {
        if (message?._id) {
            await Message.deleteOne({ _id: message._id }).catch(() => {});
            conversation.lastMessage = previousLastMessage;
            await conversation.save().catch(() => {});
        }
        throw error;
    }

    await message.populate("sender", "username");
    await message.populate("receiver", "username");

    req.app.get("io").to(`conversation:${conversationId}`)
        .to(`user:${req.user._id}`)
        .to(`user:${receiver}`)
        .emit("new_message", message);
    res.status(201).json({ message });
};

const deleteMessage = async (req, res) => {
    const { conversationId, messageId } = req.params;
    const scope = String(req.body?.scope || "");
    if (!mongoose.isValidObjectId(conversationId) || !mongoose.isValidObjectId(messageId)) {
        return res.status(400).json({ message: "Invalid conversation or message ID" });
    }
    if (!["me", "everyone"].includes(scope)) {
        return res.status(400).json({ message: "Choose whether to delete the message for you or everyone" });
    }

    const conversation = await Conversation.findById(conversationId);
    if (!conversation || !isParticipant(conversation, req.user._id)) {
        return res.status(403).json({ message: "Access denied" });
    }

    const message = await Message.findOne({ _id: messageId, conversation: conversationId });
    if (!message) return res.status(404).json({ message: "Message not found" });

    const io = req.app.get("io");
    if (scope === "me") {
        if (message.deletedForEveryone) return res.status(409).json({ message: "This message was deleted for everyone" });
        await Message.updateOne(
            { _id: message._id },
            { $addToSet: { deletedFor: req.user._id } }
        );
        const event = { messageId: message._id.toString(), conversationId: conversation._id.toString() };
        io?.to(`user:${req.user._id}`).emit("message:deleted_for_me", event);
        return res.json({ ...event, scope });
    }

    if (message.sender.toString() !== req.user._id.toString()) {
        return res.status(403).json({ message: "Only the sender can delete this message for everyone" });
    }
    if (message.deletedForEveryone) {
        return res.json({ messageId: message._id.toString(), conversationId: conversation._id.toString(), scope });
    }

    const storageKey = message.media?.storageKey;
    const deletedAt = new Date();
    await Message.updateOne(
        { _id: message._id },
        {
            $set: {
                type: "deleted",
                text: "",
                deletedForEveryone: true,
                deletedAt,
                deletedBy: req.user._id
            },
            $unset: { media: 1 }
        }
    );

    if (storageKey) {
        await deleteMedia(storageKey).catch(error => {
            console.error("Deleted message media cleanup failed", {
                code: error.code || error.name || "Error"
            });
        });
    }

    const event = {
        messageId: message._id.toString(),
        conversationId: conversation._id.toString(),
        deletedAt: deletedAt.toISOString()
    };
    io?.to(`conversation:${conversation._id}`)
        .to(`user:${message.sender}`)
        .to(`user:${message.receiver}`)
        .emit("message:deleted_for_everyone", event);
    res.json({ ...event, scope });
};

module.exports = { getMessages, createTextMessage, deleteMessage };
