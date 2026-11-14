const mongoose = require("mongoose");

let connectionPromise = null;

const connectDB = async () => {
    if (mongoose.connection.readyState === 1) return mongoose.connection;
    if (!process.env.MONGO_URI) throw new Error("MONGO_URI is required");

    if (!connectionPromise) {
        connectionPromise = mongoose.connect(process.env.MONGO_URI)
            .then(() => {
                console.log("MongoDB connected successfully");
                return mongoose.connection;
            })
            .catch(error => {
                connectionPromise = null;
                throw error;
            });
    }

    return connectionPromise;
};

mongoose.connection.on("disconnected", () => {
    connectionPromise = null;
});

module.exports = connectDB;
