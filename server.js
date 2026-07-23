{
  "name": "election-data-backend",
  "version": "1.0.0",
  "description": "Cached FEC + Census backend covering all 435 House seats and 50 Senate races",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "prewarm": "node prewarm.js"
  },
  "dependencies": {
    "express": "^4.19.2"
  },
  "engines": {
    "node": ">=18"
  }
}
