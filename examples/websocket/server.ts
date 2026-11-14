import { createServer } from 'http'
import { Server, type Socket } from 'socket.io'

const httpServer = createServer()
// CORS: the old `origin: "*` let ANY website open a socket to this demo
// chat server. Restrict to the configured origin(s).
//
// `LOOP_WS_ALLOWED_ORIGIN` may be a comma-separated list. In dev it
// defaults to the two local origins a browser actually uses: the Next.js
// dev server (:3000) and the Caddy gateway (:81) — the browser loads the
// page from the gateway and sends `Origin: http://localhost:81`. In
// production `LOOP_WS_ALLOWED_ORIGIN` MUST be set (fail-closed if unset),
// mirroring the F-1 middleware policy.
const ALLOWED_ORIGINS = (() => {
  const raw = process.env.LOOP_WS_ALLOWED_ORIGIN?.trim()
  if (raw) {
    return raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
  }
  if (process.env.NODE_ENV === 'production') return []
  return ['http://localhost:3000', 'http://localhost:81']
})()
const io = new Server(httpServer, {
  // DO NOT change the path, it is used by Caddy to forward the request to the correct port
  path: '/',
  cors: {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true)
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true)
      cb(new Error(`origin ${origin} not allowed by CORS`), false)
    },
    methods: ["GET", "POST"]
  },
  pingTimeout: 60000,
  pingInterval: 25000,
})

interface User {
  id: string
  username: string
}

interface Message {
  id: string
  username: string
  content: string
  timestamp: Date
  type: 'user' | 'system'
}

const users = new Map<string, User>()

const generateMessageId = () => Math.random().toString(36).substr(2, 9)

const createSystemMessage = (content: string): Message => ({
  id: generateMessageId(),
  username: 'System',
  content,
  timestamp: new Date(),
  type: 'system'
})

const createUserMessage = (username: string, content: string): Message => ({
  id: generateMessageId(),
  username,
  content,
  timestamp: new Date(),
  type: 'user'
})

io.on('connection', (socket: Socket) => {
  console.log(`User connected: ${socket.id}`)

  // Add test event handler
  socket.on('test', (data: unknown) => {
    console.log('Received test message:', data)
    socket.emit('test-response', { 
      message: 'Server received test message', 
      data: data,
      timestamp: new Date().toISOString()
    })
  })

  socket.on('join', (data: { username: string }) => {
    const { username } = data
    
    // Create user object
    const user: User = {
      id: socket.id,
      username
    }
    
    // Add to user list
    users.set(socket.id, user)
    
    // Send join message to all users
    const joinMessage = createSystemMessage(`${username} joined the chat room`)
    io.emit('user-joined', { user, message: joinMessage })
    
    // Send current user list to new user
    const usersList = Array.from(users.values())
    socket.emit('users-list', { users: usersList })
    
    console.log(`${username} joined the chat room, current online users: ${users.size}`)
  })

  socket.on('message', (data: { content: string; username: string }) => {
    const { content, username } = data
    const user = users.get(socket.id)
    
    if (user && user.username === username) {
      const message = createUserMessage(username, content)
      io.emit('message', message)
      console.log(`${username}: ${content}`)
    }
  })

  socket.on('disconnect', () => {
    const user = users.get(socket.id)
    
    if (user) {
      // Remove from user list
      users.delete(socket.id)
      
      // Send leave message to all users
      const leaveMessage = createSystemMessage(`${user.username} left the chat room`)
      io.emit('user-left', { user: { id: socket.id, username: user.username }, message: leaveMessage })
      
      console.log(`${user.username} left the chat room, current online users: ${users.size}`)
    } else {
      console.log(`User disconnected: ${socket.id}`)
    }
  })

  socket.on('error', (error: Error) => {
    console.error(`Socket error (${socket.id}):`, error)
  })
})

const PORT = 3003
httpServer.listen(PORT, () => {
  console.log(`WebSocket server running on port ${PORT}`)
})

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Received SIGTERM signal, shutting down server...')
  httpServer.close(() => {
    console.log('WebSocket server closed')
    process.exit(0)
  })
})

process.on('SIGINT', () => {
  console.log('Received SIGINT signal, shutting down server...')
  httpServer.close(() => {
    console.log('WebSocket server closed')
    process.exit(0)
  })
})