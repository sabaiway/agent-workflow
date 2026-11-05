# Setting up the Jev key

`jev-ask` needs no binary of its own beyond Node 22 or newer on `PATH`. It needs one thing from you:
your TypeSafe key, saved where every new shell of the agent reads it.

## 1. Save the key with the kit's connect command

Run the kit's connect command **in a terminal of your own**, not through the agent:

```bash
node <kit>/tools/jev-connect.mjs
```

`<kit>` is the folder of the installed `agent-workflow-kit` skill. The command asks for the key with
no echo, checks it with one request and saves it in your shell's startup file. The key is never
printed and never put on a command line; never paste it into the chat.

## 2. Restart the agent

Restart the agent so its shell reads the saved key, then ask it to check Jev.
