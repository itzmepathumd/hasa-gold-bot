/*
|--------------------------------------------------------------------------
| ENVIRONMENT
|--------------------------------------------------------------------------
| Two files are read, in order:
|
|   .env        tracked, shared settings, no secrets
|   .env.local  ignored, per-machine settings and any secret
|
| The second file wins, so a Firebase key or a local override never has to
| be committed. Loading it here means every module that reads
| process.env gets the same values, whichever file supplied them.
*/

require("dotenv").config();
require("dotenv").config({ path: ".env.local" });
