import { useEffect, useState } from 'react';

interface SplashScreenProps {
  onComplete: () => void;
  minimumDisplayTime?: number;
}

export function SplashScreen({ onComplete, minimumDisplayTime = 2500 }: SplashScreenProps) {
  const [phase, setPhase] = useState<'enter' | 'hold' | 'exit'>('enter');

  useEffect(() => {
    const mountTime = Date.now();

    // Enter animation takes ~1.2s, then hold
    const enterTimer = setTimeout(() => {
      setPhase('hold');
    }, 1200);

    // After minimum display time, start exit
    const exitTimer = setTimeout(() => {
      const elapsed = Date.now() - mountTime;
      const remaining = Math.max(0, minimumDisplayTime - elapsed);

      setTimeout(() => {
        setPhase('exit');
        // Wait for exit animation then complete
        setTimeout(onComplete, 500);
      }, remaining);
    }, minimumDisplayTime);

    return () => {
      clearTimeout(enterTimer);
      clearTimeout(exitTimer);
    };
  }, [onComplete, minimumDisplayTime]);

  return (
    <div className={`splash-container ${phase}`}>
      <div className="splash-content">
        {/* Orbital Icon */}
        <svg
          className="splash-icon"
          width="120"
          height="80"
          viewBox="0 0 73.622 47.359"
          fill="none"
        >
          <defs>
            <linearGradient id="splashGradient" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#7c3aed" />
              <stop offset="100%" stopColor="#06b6d4" />
            </linearGradient>
          </defs>
          <g transform="translate(37.31,24.5)">
            <circle cx="0" cy="0" r="12" fill="url(#splashGradient)" />
            <ellipse
              cx="0"
              cy="0"
              rx="35"
              ry="12"
              stroke="url(#splashGradient)"
              strokeWidth="3"
              transform="rotate(-30)"
              fill="none"
              opacity="0.8"
            />
            <circle cx="35" cy="0" r="5" fill="#06b6d4" transform="rotate(-30)" />
            <ellipse
              cx="0"
              cy="0"
              rx="35"
              ry="12"
              stroke="url(#splashGradient)"
              strokeWidth="3"
              transform="rotate(30)"
              fill="none"
              opacity="0.8"
            />
            <circle cx="-35" cy="0" r="5" fill="#7c3aed" transform="rotate(30)" />
          </g>
        </svg>

        {/* App Name */}
        <h1 className="splash-title">
          <span className="text-gradient">ACP</span>
        </h1>
        <p className="splash-subtitle">Agent Collaboration Platform</p>
      </div>

      <style>{`
        .splash-container {
          position: fixed;
          inset: 0;
          background: linear-gradient(135deg, #0f172a 0%, #1e1b4b 50%, #0f172a 100%);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 9999;
          transition: opacity 0.5s ease-out;
        }

        .splash-container.exit {
          opacity: 0;
          pointer-events: none;
        }

        .splash-content {
          display: flex;
          flex-direction: column;
          align-items: center;
          animation: splash-enter 1.2s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
        }

        .splash-container.enter .splash-content {
          opacity: 0;
          transform: translateY(40px) scale(0.8);
        }

        .splash-container.hold .splash-content,
        .splash-container.exit .splash-content {
          opacity: 1;
          transform: translateY(0) scale(1);
        }

        @keyframes splash-enter {
          0% {
            opacity: 0;
            transform: translateY(40px) scale(0.8);
          }
          70% {
            opacity: 1;
            transform: translateY(-5px) scale(1.02);
          }
          85% {
            transform: translateY(3px) scale(0.98);
          }
          100% {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }

        .splash-icon {
          width: 120px;
          height: auto;
          margin-bottom: 24px;
          filter: drop-shadow(0 0 30px rgba(124, 58, 237, 0.4));
          animation: icon-float 3s ease-in-out infinite;
        }

        @keyframes icon-float {
          0%, 100% {
            transform: translateY(0);
          }
          50% {
            transform: translateY(-8px);
          }
        }

        .splash-title {
          font-size: 48px;
          font-weight: 700;
          margin: 0;
          letter-spacing: -1px;
        }

        .text-gradient {
          background: linear-gradient(90deg, #7c3aed, #06b6d4);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
        }

        .splash-subtitle {
          font-size: 18px;
          color: #94a3b8;
          margin-top: 8px;
          font-weight: 500;
          letter-spacing: 2px;
          text-transform: uppercase;
        }
      `}</style>
    </div>
  );
}
