# Security

## Reporting a problem

Email [security@openstudio.tech](mailto:security@openstudio.tech). Do not open an issue: issues are public.

Tell us what you found, how to make it happen, and what someone could do with it. A short proof helps more than a long description. We will write back, tell you what we make of it, and tell you when it is fixed. Please give us the chance to fix it before you tell anyone else.

Only the latest release is fixed.

## What it protects, and what it does not

OpenStudio Personal is for one person on their own machine. Knowing where its lines are will save you a report.

It is meant to hold these:

- A piece reaches only what its owner granted it. A new piece is granted nothing.
- A piece's code runs with no network of its own. Everything outside goes through the control plane, which checks the grant.
- Your keys are sealed on disk and never shown back whole. They are not put in piece code, in logs or in what an AI client can read.
- A page on another website cannot make it do anything.
- When other machines can reach it, nothing is served without the secret.
- A piece cannot reach a private address on your network.

A way around any of those is a security problem, and we want to hear about it.

It does not try to do these:

- It is not a hardened sandbox. A piece you load runs with what you grant it, so run pieces you chose.
- It has no accounts or roles. On your own machine, whoever can use the computer can use it.
- `OPENSTUDIO_UNSAFE_NO_SECRET=1` turns the secret off. It is for a container whose ports are published to `127.0.0.1` alone, and anywhere else it leaves the door open, as its name says.
- What the model reads from the web or from a picture can try to mislead it. Marcel is told to treat that as material, not instructions, and that is a habit, not a wall.
