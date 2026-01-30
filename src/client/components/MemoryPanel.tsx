import SnapshotTimeline from './SnapshotTimeline';
import './MemoryPanel.css';

interface MemoryPanelProps {
  onRestoreComplete?: () => void;
}

export default function MemoryPanel({ onRestoreComplete }: MemoryPanelProps) {
  return (
    <div className="memory-panel">
      <div className="panel-intro">
        <div className="intro-icon">🦞</div>
        <div className="intro-content">
          <h3>Memory Snapshots</h3>
          <p>
            Snapshots let you save and restore moltbot's configuration.
            Create a snapshot before making risky changes, and restore it if something goes wrong.
          </p>
        </div>
      </div>

      <SnapshotTimeline onRestoreComplete={onRestoreComplete} />
    </div>
  );
}
