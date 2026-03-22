export const MOCK_AGENTS = [
  { id: 'a1', name: 'Astra', status: 'online' },
  { id: 'a2', name: 'Orion', status: 'online' },
  { id: 'a3', name: 'Nova', status: 'offline' },
]

export const MOCK_SESSIONS = [
  { id: 'sess1', name: 'Session 1' },
  { id: 'sess2', name: 'Session 2' }
]

export const MOCK_MESSAGES = {
  sess1: [
    { id: 'm1', author: 'agent', text: 'Welcome to the dashboard', timestamp: '09:00' }
  ]
}
