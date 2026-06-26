# MindSpring — secure note-taking

Restart:
docker compose down && docker compose build --no-cache && docker compose up -d

A self-hostable, containerized notepad. Notes are encrypted **in your browser**
before they're sent, so the server and database only ever store ciphertext.
Even someone with full database access cannot read your notes.

## Stack
- **Frontend**: vanilla JS + Web Crypto API, served by nginx
- **Backend**: Node/Express REST API
- **Database**: PostgreSQL with a persistent Docker volume
- **Auth**: Argon2id password hashing, JWT in an httpOnly cookie

## Run it

```bash
cp .env.example .env
# edit .env: set PGPASSWORD and JWT_SECRET to long random values
#   openssl rand -base64 48

docker compose up --build
```

Open http://localhost:8080, create an account, and start writing.

## How the encryption works

1. On register, the server stores an Argon2id hash of your password (for login)
   and a random per-user salt. It never stores the password itself.
2. In the browser, your password + that salt are run through PBKDF2
   (310,000 iterations, SHA-256) to derive a 256-bit AES-GCM key.
3. That key **never leaves the browser** and is never sent to the server.
   It lives only in memory for the session.
4. Every note is encrypted with AES-GCM (fresh random IV per save) before
   upload. The API validates only that it received bounded-length strings.
5. On load, notes are fetched as ciphertext and decrypted locally.

### What this means
- The server, the database, the volume backups, and anyone who breaches them
  see only ciphertext + IVs. Titles and bodies are unreadable without your key.
- **There is no password recovery.** The key is derived from your password; if
  you forget it, the notes cannot be decrypted by anyone, including you. This is
  the cost of true zero-knowledge storage.

## Security notes for production
- Put this behind HTTPS (a reverse proxy with TLS). Cookies are flagged
  `secure` when `NODE_ENV=production`. Set `CORS_ORIGIN` to your real origin.
- The `db` and `api` services are **not** published to the host — only nginx
  (`web`) is. Postgres is reachable only on the internal Docker network.
- Rotate `JWT_SECRET` to invalidate all sessions.
- Back up the `pgdata` volume; the ciphertext is safe to store anywhere.

## Layout
```
backend/          Express API + Postgres migrations
frontend/         Static client (crypto.js does all encryption)
nginx/            Reverse proxy + static hosting config
docker-compose.yml
```
