import React from 'react'
import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom'
import { AuthGate } from './auth/AuthGate'
import Shell from './components/Shell'
import ChatPage from './pages/ChatPage'
import ManagePage from './pages/ManagePage'

function DashboardLayout() {
  return (
    <Shell>
      <Outlet />
    </Shell>
  )
}

export default function App() {
  return (
    <AuthGate>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<DashboardLayout />}>
            <Route path="chat" element={<ChatPage />} />
            <Route path="manage" element={<ManagePage />} />
            <Route path="logs" element={<Navigate to="/manage" replace />} />
            <Route path="status" element={<Navigate to="/manage" replace />} />
            <Route index element={<Navigate to="/chat" />} />
          </Route>
          <Route path="*" element={<Navigate to="/chat" />} />
        </Routes>
      </BrowserRouter>
    </AuthGate>
  )
}
