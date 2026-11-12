"use client";

import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

export function OracleTaskFeedPanel() {
  const [tasks, setTasks] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchTasks = async () => {
      try {
        const response = await fetch('/api/self-enhance/tasks?limit=50');
        const data = await response.json();
        const oracleFailedProphecies = data.filter((task: any) => task.kind === 'oracle-failed-prophecy');
        setTasks(oracleFailedProphecies);
      } catch (error) {
        console.error('Error fetching tasks:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchTasks();
  }, []);

  if (loading) {
    return <div>Loading...</div>;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Oracle Failed Prophecies</CardTitle>
      </CardHeader>
      <CardContent>
        {tasks.length === 0 ? (
          <p>No failed prophecies found.</p>
        ) : (
          <ul className="space-y-2">
            {tasks.map((task, index) => (
              <li key={index} className="flex items-center justify-between p-2 border rounded">
                <span>{task.description || `Task #${index + 1}`}</span>
                <Badge variant="destructive">Failed</Badge>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}