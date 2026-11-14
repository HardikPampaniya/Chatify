const jwt = require("jsonwebtoken");
const User = require("../models/User");

const getTokenFromRequest = req => {
    const header = req.headers.authorization || "";
    if (header.startsWith("Bearer ")) return header.slice(7);
    return null;
};

const verifyToken = token => {
    if (!token) return null;
    try {
        return jwt.verify(token, process.env.JWT_SECRET);
    } catch {
        return null;
    }
};

const protect = async (req, res, next) => {
    try {
        const payload = verifyToken(getTokenFromRequest(req));

        if (!payload) {
            return res.status(401).json({ message: "Authentication required" });
        }

        const user = await User.findById(payload.userId).select("-passwordHash");

        if (!user) {
            return res.status(401).json({ message: "User not found" });
        }

        req.user = user;
        next();
    } catch (error) {
        next(error);
    }
};

const protectMedia = async (req, res, next) => {
    try {
        const accessToken = String(req.query.access || "");
        const payload = verifyToken(accessToken || getTokenFromRequest(req));
        if (!payload) return res.status(401).json({ message: "Authentication required" });
        if (accessToken && (payload.purpose !== "media" || payload.mediaMessageId !== req.params.filename)) {
            return res.status(401).json({ message: "Invalid media access token" });
        }

        const user = await User.findById(payload.userId).select("-passwordHash");
        if (!user) return res.status(401).json({ message: "User not found" });
        req.user = user;
        next();
    } catch (error) {
        next(error);
    }
};

const authenticateSocket = async socket => {
    const payload = verifyToken(socket.handshake.auth?.token);

    if (!payload) {
        throw new Error("Authentication required");
    }

    const user = await User.findById(payload.userId).select("-passwordHash");

    if (!user) {
        throw new Error("User not found");
    }

    return user;
};

module.exports = { protect, protectMedia, authenticateSocket };
