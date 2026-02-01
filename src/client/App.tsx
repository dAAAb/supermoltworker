import AdminPage from './pages/AdminPage'
import { NotificationContainer } from './components/NotificationToast'
import { useNotification } from './hooks/useNotification'
import './App.css'

export default function App() {
  const {
    notifications,
    pendingEvolutions,
    unreadCount,
    connected,
    dismiss,
  } = useNotification();

  const handleNotificationAction = async (
    notification: Parameters<typeof NotificationContainer>[0]['onAction'] extends ((n: infer N, a: any) => void) | undefined ? N : never,
    action: { endpoint?: string; action: string }
  ) => {
    if (action.endpoint) {
      try {
        const response = await fetch(action.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        if (!response.ok) {
          console.error('Action failed:', await response.text());
        }
      } catch (err) {
        console.error('Action failed:', err);
      }
    }

    // Dismiss after action (except for view)
    if (action.action !== 'view') {
      dismiss(notification.id);
    }
  };

  return (
    <div className="app">
      <header className="app-header">
        <img src="/logo-small.png" alt="Moltworker" className="header-logo" />
        <h1>Super Moltbot Admin</h1>
        <div className="header-status">
          {!connected && (
            <span className="status-disconnected" title="通知系統離線">
              🔴
            </span>
          )}
          {connected && unreadCount > 0 && (
            <span className="status-badge" title={`${unreadCount} 則未讀通知`}>
              {unreadCount}
            </span>
          )}
          {pendingEvolutions.length > 0 && (
            <span className="evolution-badge" title={`${pendingEvolutions.length} 個進化請求等待處理`}>
              🦞 {pendingEvolutions.length}
            </span>
          )}
        </div>
      </header>
      <main className="app-main">
        <AdminPage />
      </main>

      {/* Global notification toasts */}
      <NotificationContainer
        notifications={notifications}
        onDismiss={dismiss}
        onAction={handleNotificationAction}
        maxVisible={5}
      />
    </div>
  )
}
