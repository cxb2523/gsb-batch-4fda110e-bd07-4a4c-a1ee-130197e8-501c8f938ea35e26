import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        gold: {
          400: '#F59E0B',
          500: '#D97706',
          600: '#B45309',
        },
        atlas: {
          ink: '#101311',
          surface: '#171b18',
          paper: '#e9e5d8',
          muted: '#b8b7a8',
          dim: '#8f9186',
          signal: '#d7f36b',
          warm: '#ff765f',
        },
      },
    },
  },
  plugins: [],
}
export default config
