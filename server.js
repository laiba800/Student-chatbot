const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const fs = require('fs');
require('dotenv').config();
const { OpenAI } = require('openai');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// OpenAI Setup
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || 'dummy' });

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Ensure uploads dir exists
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

// Multer for uploads
const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

// SQLite DB
const db = new sqlite3.Database('./database.db', (err) => {
  if (err) console.error(err);
  else {
    db.run(`CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender TEXT,
      text TEXT,
      urduText TEXT,
      type TEXT,
      fileUrl TEXT,
      duration TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  }
});

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (req.file) {
    const isAudio = req.file.mimetype.startsWith('audio') || req.file.originalname.endsWith('.webm') || req.file.originalname.endsWith('.mp3') || req.file.originalname.endsWith('.wav') || req.file.originalname.endsWith('.ogg');
    const isImage = req.file.mimetype.startsWith('image');
    res.json({ url: `/uploads/${req.file.filename}`, type: isAudio ? 'audio' : (isImage ? 'image' : 'file') });
  } else {
    res.status(400).send('Upload failed');
  }
});

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  db.all('SELECT * FROM messages ORDER BY timestamp ASC', [], (err, rows) => {
    if (!err) socket.emit('history', rows);
  });

  socket.on('typing', () => {
    socket.broadcast.emit('typing');
  });

  socket.on('stopTyping', () => {
    socket.broadcast.emit('stopTyping');
  });

  socket.on('sendMessage', async (msg) => {
    let userText = msg.text || msg.urduText || '';
    
    // If it's an audio message, try to transcribe it first
    if (msg.type === 'audio' && msg.fileUrl) {
      if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'dummy') {
        try {
          const filePath = path.join(__dirname, msg.fileUrl);
          const transcription = await openai.audio.transcriptions.create({
            file: fs.createReadStream(filePath),
            model: 'whisper-1'
          });
          userText = transcription.text;
          msg.text = userText; // Update text for DB
        } catch (err) {
          console.error("Transcription error:", err);
        }
      } else {
        userText = "Mock transcribed audio text.";
        msg.text = userText;
      }
    }

    db.run(`INSERT INTO messages (sender, text, urduText, type, fileUrl, duration) VALUES (?, ?, ?, ?, ?, ?)`, 
      ['user', msg.text || '', msg.urduText || '', msg.type || 'text', msg.fileUrl || null, msg.duration || null], 
      function(err) {
        if (!err) {
           const savedMsg = { id: this.lastID, sender: 'user', ...msg, timestamp: new Date(), status: 'sent' };
           io.emit('newMessage', savedMsg);
        }
      });

    // Determine language from userText
    const isUrdu = /[\u0600-\u06FF]/.test(userText);
    let replyText = '';
    
    socket.broadcast.emit('typing'); // Show bot is typing
    
    try {
      if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'dummy') {
          const systemPrompt = isUrdu 
            ? "You are Laiba AI, a professional female AI assistant. Respond ONLY in Urdu. Keep responses concise."
            : "You are Laiba AI, a professional female AI assistant. Respond ONLY in English. Keep responses concise.";

          const response = await openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userText }
            ]
          });
          replyText = response.choices[0].message.content;
      } else {
          const mockResponses = [
               "I am Laiba AI. I received your message and my backend is fully connected!",
               "That's interesting. Tell me more about it.",
               "I can help with that. Please provide more details."
          ];
          replyText = isUrdu ? "میں لائبہ اے آئی ہوں۔ مجھے آپ کا پیغام موصول ہو گیا ہے!" : mockResponses[Math.floor(Math.random() * mockResponses.length)];
      }

      const aiMsg = {
        sender: 'bot',
        text: isUrdu ? '' : replyText,
        urduText: isUrdu ? replyText : '',
        type: 'text',
        fileUrl: null,
        duration: null
      };

      // AI TTS Voice reply
      if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'dummy' && (msg.type === 'audio' || msg.type === 'text')) {
          try {
             const mp3 = await openai.audio.speech.create({
               model: "tts-1",
               voice: "nova",
               input: replyText
             });
             const buffer = Buffer.from(await mp3.arrayBuffer());
             const filename = `ai_reply_${Date.now()}.mp3`;
             fs.writeFileSync(path.join(__dirname, 'uploads', filename), buffer);
             aiMsg.type = 'audio'; // Change to audio type so frontend plays it
             aiMsg.fileUrl = `/uploads/${filename}`;
             aiMsg.duration = 'AI';
          } catch(e) {
             console.error("TTS Error:", e);
          }
      } else if (msg.type === 'audio') {
         // Mock audio reply
         aiMsg.type = 'audio';
         aiMsg.duration = '0:05';
      }

      db.run(`INSERT INTO messages (sender, text, urduText, type, fileUrl, duration) VALUES (?, ?, ?, ?, ?, ?)`, 
        ['bot', aiMsg.text, aiMsg.urduText, aiMsg.type, aiMsg.fileUrl, aiMsg.duration], function(err) {
          if (!err) {
            io.emit('newMessage', { id: this.lastID, ...aiMsg, timestamp: new Date() });
          }
        });

    } catch (err) {
      console.error('OpenAI Error:', err);
      const errorMsg = { sender: 'bot', text: 'Error connecting to AI backend.', type: 'text' };
      io.emit('newMessage', { id: Date.now(), ...errorMsg, timestamp: new Date() });
    }
    
    socket.broadcast.emit('stopTyping');
  });

  socket.on('joinCall', () => {
     socket.broadcast.emit('userJoinedCall');
  });
  
  socket.on('leaveCall', () => {
     socket.broadcast.emit('userLeftCall');
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Laiba AI Server running on port ${PORT}`));
