import React from 'react'
import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom'
import Shell from './components/Shell'
import ChatPage from './pages/ChatPage'
import LogsPage from './pages/LogsPage'
import StatusPage from './pages/StatusPage'

function DashboardLayout() {
  return (
    <Shell>
      <Outlet />
    </Shell>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<DashboardLayout />}> 
          <Route path="chat" element={<ChatPage />} />
          <Route path="logs" element={<LogsPage />} />
          <Route path="status" element={<StatusPage />} />
          <Route index element={<Navigate to="/chat" />} />
        </Route>
        <Route path="*" element={<Navigate to="/chat" />} />
      </Routes>
    </BrowserRouter>
  )
}
