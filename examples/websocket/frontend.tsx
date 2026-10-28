'use client';

import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { io, Socket } from 'socket.io-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';

export type User = {
  id: string;
  username: string;
};

export type Message = {
  id: string;
  username: string;
  content: string;
  timestamp: Date | string;
  type: 'user' | 'system';
};

export default function SocketDemo() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputMessage, setInputMessage] = useState('');
  const [username, setUsername] = useState('');
  const [isUsernameSet, setIsUsernameSet] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  
  const socketRef = useRef<Socket | null>(null);
  const usersMapRef = useRef<Map<string, User>>(new Map());
  const [, setUsersVersion] = useState(0);

  const triggerUsersUpdate = useCallback(() => {
    setUsersVersion((v) => v + 1);
  }, []);

  useEffect(() => {
    // Connect to websocket server
    // Never use PORT in the URL, always use XTransformPort
    // DO NOT change the path, it is used by Caddy to forward the request to the correct port
    const socketInstance = io('/?XTransformPort=3003', {
      transports: ['websocket', 'polling'],
      forceNew: true,
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
      timeout: 10000,
    });

    socketRef.current = socketInstance;

    const handleConnect = () => {
      setIsConnected(true);
    };

    const handleDisconnect = () => {
      setIsConnected(false);
    };

    const handleMessage = (msg: Message) => {
      setMessages((prev) => [...prev, msg]);
    };

    const handleUserJoined = (data: { user: User; message: Message }) => {
      setMessages((prev) => [...prev, data.message]);
      if (!usersMapRef.current.has(data.user.id)) {
        usersMapRef.current.set(data.user.id, data.user);
        triggerUsersUpdate();
      }
    };

    const handleUserLeft = (data: { user: User; message: Message }) => {
      setMessages((prev) => [...prev, data.message]);
      if (usersMapRef.current.has(data.user.id)) {
        usersMapRef.current.delete(data.user.id);
        triggerUsersUpdate();
      }
    };

    const handleUsersList = (data: { users: User[] }) => {
      usersMapRef.current.clear();
      for (let i = 0; i < data.users.length; i++) {
        const u = data.users[i];
        usersMapRef.current.set(u.id, u);
      }
      triggerUsersUpdate();
    };

    socketInstance.on('connect', handleConnect);
    socketInstance.on('disconnect', handleDisconnect);
    socketInstance.on('message', handleMessage);
    socketInstance.on('user-joined', handleUserJoined);
    socketInstance.on('user-left', handleUserLeft);
    socketInstance.on('users-list', handleUsersList);

    return () => {
      socketInstance.off('connect', handleConnect);
      socketInstance.off('disconnect', handleDisconnect);
      socketInstance.off('message', handleMessage);
      socketInstance.off('user-joined', handleUserJoined);
      socketInstance.off('user-left', handleUserLeft);
      socketInstance.off('users-list', handleUsersList);
      socketInstance.disconnect();
    };
  }, [triggerUsersUpdate]);

  const handleJoin = useCallback(() => {
    const trimmedUsername = username.trim();
    const sock = socketRef.current;
    if (sock && trimmedUsername && isConnected) {
      sock.emit('join', { username: trimmedUsername });
      setIsUsernameSet(true);
    }
  }, [username, isConnected]);

  const sendMessage = useCallback(() => {
    const trimmedInput = inputMessage.trim();
    const trimmedUsername = username.trim();
    const sock = socketRef.current;
    if (sock && trimmedInput && trimmedUsername) {
      sock.emit('message', {
        content: trimmedInput,
        username: trimmedUsername,
      });
      setInputMessage('');
    }
  }, [inputMessage, username]);

  const handleKeyPress = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      sendMessage();
    }
  }, [sendMessage]);

  const handleUsernameKeyPress = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleJoin();
    }
  }, [handleJoin]);

  const connectionBadgeClass = useMemo(() => 
    `text-sm px-2 py-1 rounded ${isConnected ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`,
    [isConnected]
  );

  return (
    <div className="container mx-auto p-4 max-w-2xl">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            WebSocket Demo
            <span className={connectionBadgeClass}>
              {isConnected ? 'Connected' : 'Disconnected'}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {!isUsernameSet ? (
            <div className="space-y-2">
              <Input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                onKeyDown={handleUsernameKeyPress}
                placeholder="Enter your username..."
                disabled={!isConnected}
                className="flex-1"
              />
              <Button
                onClick={handleJoin}
                disabled={!isConnected || !username.trim()}
                className="w-full"
              >
                Join Chat
              </Button>
            </div>
          ) : (
            <>
              <ScrollArea className="h-80 w-full border rounded-md p-4">
                <div className="space-y-2">
                  {messages.length === 0 ? (
                    <p className="text-gray-500 text-center">No messages yet</p>
                  ) : (
                    messages.map((msg) => {
                      const isSystem = msg.type === 'system';
                      return (
                        <div key={msg.id} className="border-b pb-2 last:border-b-0">
                          <div className="flex justify-between items-start">
                            <div className="flex-1">
                              <p className={`text-sm font-medium ${isSystem ? 'text-blue-600 italic' : 'text-gray-700'}`}>
                                {msg.username}
                              </p>
                              <p className={`${isSystem ? 'text-blue-500 italic' : 'text-gray-900'}`}>
                                {msg.content}
                              </p>
                            </div>
                            <span className="text-xs text-gray-500">
                              {new Date(msg.timestamp).toLocaleTimeString()}
                            </span>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </ScrollArea>

              <div className="flex space-x-2">
                <Input
                  value={inputMessage}
                  onChange={(e) => setInputMessage(e.target.value)}
                  onKeyDown={handleKeyPress}
                  placeholder="Type a message..."
                  disabled={!isConnected}
                  className="flex-1"
                />
                <Button
                  onClick={sendMessage}
                  disabled={!isConnected || !inputMessage.trim()}
                >
                  Send
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
