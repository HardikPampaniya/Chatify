const mongoose = require("mongoose");

const friendRequestSchema = new mongoose.Schema(
    {
        requester: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
        recipient: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
        status: { type: String, enum: ["pending", "accepted", "rejected"], default: "pending", required: true },
        respondedAt: { type: Date, default: null }
    },
    { timestamps: true }
);

friendRequestSchema.index({ requester: 1, recipient: 1 }, { unique: true });
friendRequestSchema.index({ recipient: 1, status: 1, createdAt: -1 });
friendRequestSchema.index({ requester: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model("FriendRequest", friendRequestSchema);
