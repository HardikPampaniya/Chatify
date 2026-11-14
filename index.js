require("dotenv").config();

// Vercel's Express adapter needs the Express application as the entrypoint export.
require("express");
module.exports = require("./server/app").app;
