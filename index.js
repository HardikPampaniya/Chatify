require("dotenv").config();

// Keep the Express dependency visible in this recognized Vercel entrypoint.
require("express");

// Export the HTTP server so Vercel can also attach the Socket.IO upgrade handler.
module.exports = require("./server/app").server;
