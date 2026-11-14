require("dotenv").config();

const express = require("express");
const http = require("http");
const path = require("path");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const cookieParser = require("cookie-parser");
const { Server } = require("socket.io");

const connectDB = require("./config/database");
const { corsOrigin, mediaUploadOrigins } = require("./config/clientOrigin");
const authRoutes = require("./routes/auth");
const userRoutes = require("./routes/users");
const conversationRoutes = require("./routes/conversations");
const messageRoutes = require("./routes/messages");
const errorHandler = require("./middleware/errorHandler");
const initializeChatSocket = require("./socket/chatSocket");

const app = express();
const server = http.createServer(app);
app.set("trust proxy", 1);

app.use(helmet({
    crossOriginResourcePolicy: { policy: "same-site" },
    contentSecurityPolicy: {
        directives: {
            "connect-src": ["'self'", "wss:", "ws://localhost:3000", ...mediaUploadOrigins()]
        }
    }
}));

app.use(cors({ origin: corsOrigin, credentials: true }));

app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false, limit: "100kb" }));
app.use(cookieParser());

app.use(rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 600,
    standardHeaders: true,
    legacyHeaders: false
}));

const publicRoot = path.join(__dirname, "../public");
app.use(express.static(publicRoot));
app.use("/css", express.static(path.join(publicRoot, "css")));
app.use("/js", express.static(path.join(publicRoot, "js")));
app.use("/images", express.static(path.join(publicRoot, "images")));

app.get("/", (req, res) => res.sendFile(path.join(publicRoot, "index.html")));
app.get("/healthz", (req, res) => res.status(200).json({ status: "ok" }));

app.use("/api", async (req, res, next) => {
    try {
        await connectDB();
        next();
    } catch (error) {
        next(error);
    }
});

app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/conversations", conversationRoutes);
app.use("/api/messages", messageRoutes);

app.use(errorHandler);

const io = new Server(server, {
    cors: { origin: corsOrigin, credentials: true },
    maxHttpBufferSize: 100000
});

initializeChatSocket(io);
app.set("io", io);

module.exports = { app, server, io };
