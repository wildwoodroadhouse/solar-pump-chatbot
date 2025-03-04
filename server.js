// Minimal server.js for testing
const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

// Basic test route
app.get('/', (req, res) => {
  res.send('Solar Pump Chatbot API is running - Test Version');
});

app.get('/api/hello', (req, res) => {
  res.json({ message: 'Hello from the API!' });
});

// Start the server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});