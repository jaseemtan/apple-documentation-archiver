<pre>
apple-docs-offline

A node.js script to download Apple Documentation Archive pages for offline
viewing.

All assets are saved to local and links in the html files updated to point to
local.

Installation:

$ npm install

Run:

$ node main.js

Once the download is complete run:

$ ./setup

to update the missing files.

The offline archive will be saved under the offline folder within the project.
It would be ideal to run the script to download all contents in one go.

The offline contents should be served through a local server for it to function
properly.

View documentation:

Start a static server in the offline directory. Navigate to 
http://127.0.0.1:8081/developer.apple.com/library/archive/navigation/ 
to view the documentation. The local address may vary.
</pre>