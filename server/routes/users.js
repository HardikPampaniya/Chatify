const express = require("express");
const {
    getUsers,
    getFriendRequests,
    sendFriendRequest,
    acceptFriendRequest,
    rejectFriendRequest,
    cancelFriendRequest
} = require("../controllers/userController");
const { protect } = require("../middleware/auth");

const router = express.Router();
router.use(protect);
router.get("/", getUsers);
router.get("/requests", getFriendRequests);
router.post("/requests/:userId", sendFriendRequest);
router.post("/requests/:requestId/accept", acceptFriendRequest);
router.post("/requests/:requestId/reject", rejectFriendRequest);
router.delete("/requests/:requestId", cancelFriendRequest);

module.exports = router;
