const express = require("express");
const rateLimit = require("express-rate-limit");
const { getMessages, createTextMessage, deleteMessage } = require("../controllers/messageController");
const { sendMedia, getMedia, createMediaAccess } = require("../controllers/mediaController");
const {
    initiateMultipartUpload,
    presignMultipartPart,
    confirmMultipartPart,
    finishMultipartUpload,
    cancelMultipartUpload
} = require("../controllers/multipartMediaController");
const { protect, protectMedia } = require("../middleware/auth");
const requireConversationParticipant = require("../middleware/conversationAccess");
const upload = require("../middleware/upload");

const router = express.Router();
const uploadLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: "Too many uploads. Try again later." }
});
router.get("/media/:filename/access", protect, createMediaAccess);
router.get("/media/:filename", protectMedia, getMedia);
router.get("/:conversationId", protect, getMessages);
router.post("/:conversationId", protect, createTextMessage);
router.delete("/:conversationId/:messageId", protect, deleteMessage);
router.post("/:conversationId/media/multipart", protect, requireConversationParticipant, initiateMultipartUpload);
router.post(
    "/:conversationId/media/multipart/:uploadId/parts/:partNumber/presign",
    protect,
    requireConversationParticipant,
    presignMultipartPart
);
router.post(
    "/:conversationId/media/multipart/:uploadId/parts/:partNumber/confirm",
    protect,
    requireConversationParticipant,
    confirmMultipartPart
);
router.post(
    "/:conversationId/media/multipart/:uploadId/complete",
    protect,
    requireConversationParticipant,
    finishMultipartUpload
);
router.delete(
    "/:conversationId/media/multipart/:uploadId",
    protect,
    requireConversationParticipant,
    cancelMultipartUpload
);
router.post("/:conversationId/media", protect, requireConversationParticipant, uploadLimiter, upload.single("media"), sendMedia);

module.exports = router;
