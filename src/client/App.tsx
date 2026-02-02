import AdminPage from './pages/AdminPage'
import CriticalAlertsBar from './components/CriticalAlertsBar'
import './App.css'

export default function App() {
  return (
    <div className="app">
      <header className="app-header">
        <img src="/logo-small.png" alt="Moltworker" className="header-logo" />
        <h1>Super Moltbot Admin</h1>
      </header>
      <main className="app-main">
        {/* Critical alerts at the top */}
        <CriticalAlertsBar />

        <AdminPage />
      </main>
    </div>
  )
}
