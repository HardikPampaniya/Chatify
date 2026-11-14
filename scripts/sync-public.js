const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const publicRoot = path.join(root, "public");
fs.mkdirSync(publicRoot, { recursive: true });

for (const directory of ["css", "js", "images"]) {
    const source = path.join(root, directory);
    if (fs.existsSync(source)) {
        fs.cpSync(source, path.join(publicRoot, directory), {
            recursive: true,
            force: true
        });
    }
}

fs.copyFileSync(path.join(root, "client", "auth.html"), path.join(publicRoot, "index.html"));
fs.copyFileSync(path.join(root, "client", "chat.html"), path.join(publicRoot, "chat.html"));
fs.copyFileSync(path.join(root, "client", "profile.html"), path.join(publicRoot, "profile.html"));
