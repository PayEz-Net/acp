import { Octagon } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';

export function EmergencyStopButton() {
  const { autonomyEnabled, setAutonomyStatus, setAutonomyEnabled } = useAppStore();

  if (!autonomyEnabled) return null;

  const handleEmergencyStop = async () => {
    // TODO: Call backend API POST /v1/autonomy/stop with reason: 'emergency'
    // Immediate stop - no confirmation needed
    setAutonomyStatus(null);
    setAutonomyEnabled(false);
    console.log('[Autonomy] Emergency stop triggered');
  };

  return (
    <button
      onClick={handleEmergencyStop}
      className="fixed bottom-6 right-6 z-40 flex items-center gap-2 px-4 py-3 bg-red-600 hover:bg-red-700 text-white rounded-lg shadow-lg shadow-red-900/50 font-medium transition-all hover:scale-105 active:scale-95"
      title="Emergency Stop - Click to immediately stop all autonomous work"
      aria-label="Emergency stop - immediately stop all autonomous work"
    >
      <Octagon className="w-5 h-5" />
      <span>STOP</span>
    </button>
  );
}
