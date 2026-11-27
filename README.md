# I.O.U. Lightning demo
Node + Express backend that talks to Polar LND nodes (Alice, Bob, Carol) over REST. Frontend is plain JS in /public.
1. `cp .env.example .env` and fill in the macaroon paths from Polar (node > Connect).
2. `npm install && npm start`, then open http://localhost:3000.
Drop real logos into public/logos/<name>.png (e.g. spotify.png, airtel-money.png, national-bank.png); initials show otherwise.
