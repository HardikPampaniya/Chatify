require("dotenv").config();

const connectDB = require("./config/database");
const { app, server, io } = require("./app");

const PORT = process.env.PORT || 3000;

const start = async () => {
    if (!process.env.MONGO_URI || !process.env.JWT_SECRET) {
        console.error("MONGO_URI and JWT_SECRET are required");
        process.exit(1);
    }

    try {
        await connectDB();
        server.listen(PORT, () => console.log("HTTP server is listening"));
    } catch (error) {
        console.error("Server startup failed", { name: error.name || "Error", code: error.code });
        process.exit(1);
    }
};

if (require.main === module) start();

module.exports = { app, server, io, start };
