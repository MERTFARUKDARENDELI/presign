# AI Web3 Security Agent & Defender

> AI-powered security agent for detecting and defending against malicious tokens, phishing transactions, and wallet drainers on Solana.

## 🛡️ Overview

**AI Web3 Security Agent & Defender** is a Solana-focused security platform designed to protect users **before they sign a transaction**.

The system combines blockchain data, deterministic security rules, transaction simulation, and AI-powered analysis to identify potentially malicious activity and explain the risk in a clear and actionable way.

### Core Security Flow

```text
Blockchain Data
       ↓
Pre-Transaction Simulation
       ↓
Deterministic Risk Engine
       ↓
AI Security Analysis
       ↓
Risk Explanation
       ↓
Actionable Defense
```

## 🎯 Problem

Web3 users can unknowingly interact with:

* Phishing transactions
* Wallet drainers
* Malicious smart contracts/programs
* Scam tokens
* Suspicious token accounts
* High-risk token authorities
* Unexpected asset transfers

Traditional wallet interfaces often show transaction data without explaining **what the transaction actually does to the user's assets**.

This project aims to make transaction security understandable before the user signs.

## 🔐 Security Layers

### 1. Wallet & Token Security Scanner

Analyzes wallet assets and identifies potentially suspicious tokens using blockchain and token-risk signals.

### 2. Pre-Transaction Simulation

Simulates a transaction before signing and analyzes:

* Account balance changes
* Token balance changes
* Transaction instructions
* Program interactions
* Destination addresses
* Transaction errors
* Unexpected asset outflows

### 3. Deterministic Risk Engine

Combines security signals into transparent risk levels:

```text
CRITICAL
HIGH
MEDIUM
LOW
```

Example signals include:

* Unexpected balance outflow
* Active Mint Authority
* Active Freeze Authority
* Token-2022 Permanent Delegate
* Extremely low liquidity
* Recent liquidity removal
* New token / insufficient data
* Suspicious destination
* Risky program interaction

### 4. AI Security Agent

The AI layer explains technical security findings in human-readable language and helps users understand:

> What is this transaction doing?

> What could I lose?

> Why is it risky?

> What should I do next?

## 🧠 AI Security Tools

The planned agent architecture includes tools such as:

```text
get_wallet_tokens()
analyze_token_contract()
simulate_transaction()
find_scam_tokens()
execute_burn_transaction()
```

Additional analysis capabilities may include transaction decoding, destination inspection, and balance-change analysis.

## 🧹 Burn & Reclaim

The platform includes a defensive cleanup flow for eligible unwanted or suspicious token accounts.

```text
Suspicious Token Detected
          ↓
User Review
          ↓
Burn Token
          ↓
Token Balance = 0
          ↓
Close Token Account
          ↓
Reclaim Eligible Lamports
          ↓
User Wallet
```

All destructive actions are intended to require explicit user confirmation.

Private keys and seed phrases are never required by the platform.

## 🏗️ Tech Stack

### Frontend

* Next.js
* React
* TypeScript
* Tailwind CSS
* shadcn/ui
* Lucide Icons

### Blockchain

* Solana
* Helius
* RugCheck

### AI

* OpenAI API
* Vercel AI SDK

### Development

* Git
* GitHub
* ESLint

## 📁 Project Structure

```text
solana-ai-defender/
│
├── app/
│   ├── api/
│   ├── globals.css
│   ├── layout.tsx
│   └── page.tsx
│
├── components/
│   ├── security/
│   ├── transaction/
│   ├── wallet/
│   ├── ui/
│   └── SecurityHeader.tsx
│
├── lib/
│   ├── ai/
│   ├── security/
│   └── solana/
│
├── public/
│
├── .env.example
├── .env.local
├── components.json
├── next.config.ts
├── package.json
├── tsconfig.json
└── README.md
```

## 🚀 Getting Started

### Requirements

* Node.js 24+
* npm
* Git

### Installation

Clone the repository:

```bash
git clone https://github.com/MERTFARUKDARENDELI/solana-ai-defender.git
```

Enter the project directory:

```bash
cd solana-ai-defender
```

Install dependencies:

```bash
npm install
```

Create your local environment file:

```bash
copy .env.example .env.local
```

Add the required API keys to `.env.local`.

Example:

```env
NEXT_PUBLIC_APP_NAME="AI Web3 Security Agent"

HELIUS_API_KEY=
RUGCHECK_API_KEY=
OPENAI_API_KEY=
```

Start the development server:

```bash
npm run dev
```

Open:

```text
http://localhost:3000
```

## 🔒 Environment & Security

Never commit real API keys.

The project uses:

```text
.env.local
```

for local secrets.

The repository only contains:

```text
.env.example
```

with empty example values.

**Never share private keys or seed phrases.**

## 🧪 Development

Run the linter:

```bash
npm run lint
```

Create a production build:

```bash
npm run build
```

## 🗺️ Development Roadmap

### MVP

* [x] Project infrastructure
* [x] Next.js + TypeScript
* [x] Tailwind CSS
* [x] shadcn/ui
* [ ] Solana / Helius integration
* [ ] Token security scanner
* [ ] Deterministic risk engine
* [ ] Transaction decoder
* [ ] Pre-transaction simulation
* [ ] Transaction risk analysis
* [ ] AI security agent
* [ ] Scam token detection
* [ ] Burn & Reclaim
* [ ] Wallet connection
* [ ] Security dashboard

### Future

* [ ] Wallet security score
* [ ] Portfolio risk analysis
* [ ] Whale intelligence
* [ ] Security alerts
* [ ] Realtime wallet monitoring
* [ ] Phishing protection
* [ ] Security reports
* [ ] Advanced AI security chat
* [ ] Production deployment
* [ ] Security audit

## ⚠️ Disclaimer

This project is developed for educational, research, and hackathon purposes.

Blockchain interactions can involve irreversible asset transfers. Users should independently verify transactions before signing them.

No security system can guarantee detection of every malicious transaction or token.

## 📄 License

License information will be added as the project matures.
