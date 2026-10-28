import { createServer, Server as HttpServer } from 'http'
import { Server, Socket } from 'socket.io'

// ==========================================
// Types & Interfaces
// ==========================================

export interface User {
  readonly id: string
  readonly username: string
}

export type MessageType = 'user' | 'system'

export interface Message {
  readonly id: string
  readonly username: string
  readonly content: string
  readonly timestamp: Date
  readonly type: MessageType
}

export interface JoinPayload {
  readonly username: string
}

export interface MessagePayload {
  readonly username: string
  readonly content: string
}

export interface TestPayload {
  readonly [key: string]: unknown
}

// ==========================================
// Constants & Server Initialization
// ==========================================

const PORT = 3003
const PING_TIMEOUT_MS = 60000
const PING_INTERVAL_MS = 25000

const httpServer: HttpServer = createServer()
const io = new Server(httpServer, {
  // DO NOT change the path, it is used by Caddy to forward the request to the correct port
  path: '/',
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  pingTimeout: PING_TIMEOUT_MS,
  pingInterval: PING_INTERVAL_MS,
})

const activeUsers = new Map<string, User>()

// ==========================================
// Factory Functions
// ==========================================

const generateMessageId = (): string => Math.random().toString(36).substring(2, 11)

const createSystemMessage = (content: string): Message => ({
  id: generateMessageId(),
  username: 'System',
  content,
  timestamp: new Date(),
  type: 'system',
})

const createUserMessage = (username: string, content: string): Message => ({
  id: generateMessageId(),
  username,
  content,
  timestamp: new Date(),
  type: 'user',
})

// ==========================================
// Socket Event Handlers
// ==========================================

const registerTestHandlers = (socket: Socket): void => {
  socket.on('test', (data: TestPayload) => {
    console.log('Received test message:', data)
    socket.emit('test-response', {
      message: 'Server received test message',
      data,
      timestamp: new Date().toISOString(),
    })
  })
}

const registerRoomHandlers = (socket: Socket, ioServer: Server): void => {
  socket.on('join', ({ username }: JoinPayload) => {
    const user: User = {
      id: socket.id,
      username,
    }

    activeUsers.set(socket.id, user)

    const joinMessage = createSystemMessage(`${username} joined the chat room`)
    ioServer.emit('user-joined', { user, message: joinMessage })

    const usersList = Array.from(activeUsers.values())
    socket.emit('users-list', { users: usersList })

    console.log(`${username} joined the chat room, current online users: ${activeUsers.size}`)
  })

  socket.on('message', ({ content, username }: MessagePayload) => {
    const user = activeUsers.get(socket.id)

    if (user && user.username === username) {
      const message = createUserMessage(username, content)
      ioServer.emit('message', message)
      console.log(`${username}: ${content}`)
    }
  })
}

const registerConnectionLifecycle = (socket: Socket, ioServer: Server): void => {
  console.log(`User connected: ${socket.id}`)

  registerTestHandlers(socket)
  registerRoomHandlers(socket, ioServer)

  socket.on('disconnect', () => {
    const user = activeUsers.get(socket.id)

    if (user) {
      activeUsers.delete(socket.id)

      const leaveMessage = createSystemMessage(`${user.username} left the chat room`)
      ioServer.emit('user-left', {
        user: { id: socket.id, username: user.username },
        message: leaveMessage,
      })

      console.log(`${user.username} left the chat room, current online users: ${activeUsers.size}`)
    } else {
      console.log(`User disconnected: ${socket.id}`)
    }
  })

  socket.on('error', (error: Error) => {
    console.error(`Socket error (${socket.id}):`, error)
  })
}

io.on('connection', (socket) => {
  registerConnectionLifecycle(socket, io)
})

// ==========================================
// Server Bootstrap & Lifecycle Management
// ==========================================

httpServer.listen(PORT, () => {
  console.log(`WebSocket server running on port ${PORT}`)
})

const handleShutdown = (signal: string): void => {
  console.log(`Received ${signal} signal, shutting down server...`)
  httpServer.close(() => {
    console.log('WebSocket server closed')
    process.exit(0)
  })
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'))
process.on('SIGINT', () => handleShutdown('SIGINT'))
