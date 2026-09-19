// Tailwind v4 is wired up here so the frontend branches (feat/director,
// feat/surgeon) are not blocked on setup. No UI is built on this branch.
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
