{
  "name": "intercom-swap-backend",
  "version": "1.0.0",
  "scripts": {
    "dev": "nodemon src/index.js",
    "start": "node src/index.js"
  },
  "dependencies": {
    "express": "^4.19.2",
    "socket.io": "^4.7.5",
    "telegraf": "^4.16.3",
    "dotenv": "^16.4.5",
    "better-sqlite3": "^11.3.0",
    "cors": "^2.8.5",
    "@solana/web3.js": "^1.95.2"
  },
  "devDependencies": {
    "nodemon": "^3.1.0"
  }
}
