/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/renderer/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        vibe: {
          50: '#f5f3ff',
          100: '#ede9fe',
          200: '#ddd6fe',
          300: '#c4b5fd',
          400: '#a78bfa',
          500: '#8b5cf6',
          600: '#7c3aed',
          700: '#6d28d9',
          800: '#5b21b6',
          900: '#4c1d95',
          950: '#2e1065',
        },
        acp: {
          bg: '#0B0F17',
          surface: '#111827',
          'surface-raised': '#1F2937',
          border: '#374151',
          'border-focus': '#6366F1',
          'text-primary': '#F9FAFB',
          'text-secondary': '#9CA3AF',
          'text-muted': '#6B7280',
          accent: '#6366F1',
          'accent-hover': '#4F46E5',
          'status-ready': '#10B981',
          'status-busy': '#F59E0B',
          'status-idle': '#3B82F6',
          'status-error': '#EF4444',
          'status-offline': '#6B7280',
        },
      },
    },
  },
  plugins: [],
};
