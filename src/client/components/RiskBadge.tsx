/**
 * Risk Badge Component
 *
 * Displays risk level with appropriate color and icon.
 */

import './RiskBadge.css';

export type RiskLevel = 'safe' | 'medium' | 'high';

interface RiskBadgeProps {
  level: RiskLevel;
  showLabel?: boolean;
  size?: 'sm' | 'md' | 'lg';
}

export default function RiskBadge({ level, showLabel = true, size = 'md' }: RiskBadgeProps) {
  const getIcon = () => {
    switch (level) {
      case 'safe':
        return '🟢';
      case 'medium':
        return '🟡';
      case 'high':
        return '🔴';
      default:
        return '⚪';
    }
  };

  const getLabel = () => {
    switch (level) {
      case 'safe':
        return 'Safe';
      case 'medium':
        return 'Medium';
      case 'high':
        return 'High';
      default:
        return 'Unknown';
    }
  };

  return (
    <span className={`risk-badge risk-${level} size-${size}`}>
      <span className="risk-icon">{getIcon()}</span>
      {showLabel && <span className="risk-label">{getLabel()}</span>}
    </span>
  );
}
