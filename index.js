const path = require('path');
const axios = require('axios');
const AdmZip = require('adm-zip');
const csvtojson = require('csvtojson');
const express = require('express');
const snakecaseKeys = require('snakecase-keys');
const { JSDOM } = require('jsdom');
const NodeCache = require("node-cache");
const cache = new NodeCache();

const app = express();

// serve files inside the public folder from /
app.use(express.static('public'));

async function getCached(key, ttl, callback) {

    // find data from cache
    let data = cache.get(key);

    // update cache
    if(!data){
        data = await callback();
        cache.set(key, data, ttl);
    }

    // get expiration time in seconds
    const cacheTtl = cache.getTtl(key);
    const expiresIn = cacheTtl != null
        ? Math.ceil((cacheTtl - Date.now()) / 1000)
        : 0;

    // return data
    return [ data, expiresIn ];

}

async function getIrlpNodeStatusTxt() {

    // fetch irlp status zip
    const body = await axios.get("https://status.irlp.net/nohtmlstatus.txt.zip", {
        responseType: 'arraybuffer',
    });

    // return file contents of "nohtmlstatus.txt"
    var zip = new AdmZip(body.data);
    var zipEntries = zip.getEntries();
    for(var i = 0; i < zipEntries.length; i++){
        const entry = zipEntries[i];
        const name = entry.name;
        if(name == "nohtmlstatus.txt"){
            return zip.readAsText(entry);
        }
    }

    throw "nohtmlstatus.txt was not found in irlp status zip";

}

async function getIrlpNodeStatusJson() {

    // get irlp node status txt
    const txt = await getIrlpNodeStatusTxt();

    // convert it to json
    const json = await csvtojson({
        output: "json",
        delimiter: "\t",
        flatKeys: true, // don't interpret dots as new key
    }).fromString(txt);

    // convert json keys to snake case
    var snakeCasedObjects = snakecaseKeys(json);

    var nodes = [];

    // process each node
    for(var node of snakeCasedObjects){

        // skip error at end of node status file
        // Deprecated: str_replace(): Passing null to parameter #3 ($subject) of type array|string is deprecated in /var/www/html/irlpstatus/tasks/IRLPnohtml.php on line 19
        if(node.node.startsWith("Deprecated:")){
            continue;
        }

        nodes.push({
            id: node.node,
            status: node.status,
            avrs_status: node.avrs_status,
            callsign: node.call_sign,
            owner: node.owner,
            city: node.city,
            country: node.country,
            province_or_state: node.prov_st,
            latitude: node.lat,
            longitude: node.long,
            frequency_output_mhz: node.freq,
            frequency_input_mhz: (parseFloat(node.freq) + (parseFloat(node.offset) / 1000)).toFixed(4),
            frequency_offset_khz: node.offset,
            frequency_ctcss_hz: node.pl,
            url: node.url,
            installed_at: node.install_date, // when the node was installed
            status_updated_at: new Date(parseInt(node.last_status_change) * 1000), // current node status duration
            updated_at: new Date(parseInt(node.lastupdate) * 1000), // last heard from node
        });

    }

    return nodes;

}

async function getIrlpReflectorStatusJson() {

    const reflectors = [];

    const response = await axios.get('https://status.irlp.net/index.php?PSTART=1');
    const html = response.data;

    const dom = new JSDOM(html);

    // find main table that contains the reflectors, channels and nodes
    var table = dom.window.document.querySelector('body > center > center > table');
    for(var tableRow of table.children){
        for(var td of tableRow.children){
            for(var element of td.children){

                // find first CENTER element
                var firstElement = element.firstElementChild;
                if(firstElement == null || firstElement.tagName !== "CENTER"){
                    continue;
                }

                // get text content of CENTER element
                var textContent = firstElement.textContent;

                // parse reflector number
                var reflectorMatches = textContent.match(/Reflector: ([0-9\.]+)/);
                var reflectorNumber = reflectorMatches[1];

                // create default channels
                var channels = {};
                for(var channelNumber = 0; channelNumber <= 9; channelNumber++){
                    channels[channelNumber] = {
                        'id': String(parseInt(reflectorNumber) + channelNumber),
                        'name': "Channel " + channelNumber,
                        'nodes': [],
                    };
                }

                // parse channels
                var currentChannelNumber = null;
                for(var reflectorElements of firstElement.querySelector('table > tbody').children){

                    // determine if element is a node row, else it's a channel row
                    var isNodeRow = reflectorElements.children.length == 3;
                    var reflectorElementsTextContent = reflectorElements.textContent;
                    if(reflectorElementsTextContent === ""){
                        continue;
                    }

                    if(isNodeRow){

                        // parse node info
                        var nodeId = reflectorElements.children[0].textContent;
                        var nodeCallsign = reflectorElements.children[1].textContent;
                        var nodeCity = reflectorElements.children[2].textContent;

                        // add node to reflector channel
                        channels[channelNumber]['nodes'].push({
                            id: nodeId,
                            callsign: nodeCallsign,
                            city: nodeCity,
                        });

                    } else {

                        // parse channel info
                        var channelNumberMatches = reflectorElements.textContent.match(/Channel :([0-9\.]+)/);
                        var channelNumber = channelNumberMatches[1];

                        // update current channel
                        currentChannelNumber = channelNumber;

                    }


                }

                // add reflector
                reflectors.push({
                    id: reflectorNumber,
                    channels: Object.values(channels),
                });

            }
        }
    }

    // order reflectors by id asc
    reflectors.sort((reflectorA, reflectorB) => {
        return reflectorA.id - reflectorB.id;
    });

    return reflectors;

}

app.get('/', async (req, res) => {
    res.sendFile(path.join(__dirname, '/index.html'));
});

app.get('/api', async (req, res) => {

    const links = [
        {
            "path": "/api",
            "description": "This page",
        },
        {
            "path": "/api/v1/nodes",
            "description": "IRLP nodes in JSON format.",
        },
        {
            "path": "/api/v1/reflectors",
            "description": "IRLP reflectors in JSON format.",
        },
    ];

    const html = links.map((link) => {
        return `<li><a href="${link.path}">${link.path}</a> - ${link.description}</li>`;
    }).join("");

    res.send(html);

});

app.get('/api/v1/nodes', async (req, res) => {
    try {

        // get nodes from cache, or retrieve from api
        const [ nodes, expiresIn ] = await getCached('nodes', 10, async () => {
            return await getIrlpNodeStatusJson();
        });

        res.json({
            expires_in: expiresIn,
            nodes: nodes,
        });

    } catch(err) {
        console.error(err);
        res.status(500).json({
            message: "Something went wrong, try again later.",
        });
    }
});

app.get('/api/v1/reflectors', async (req, res) => {
    try {

        // get reflectors from cache, or retrieve from api
        const [ reflectors, expiresIn ] = await getCached('reflectors', 10, async () => {
            return await getIrlpReflectorStatusJson();
        });

        res.json({
            expires_in: expiresIn,
            reflectors: reflectors,
        });

    } catch(err) {
        console.error(err);
        res.status(500).json({
            message: "Something went wrong, try again later.",
        });
    }
});

// start express server
const port = 8080;
const listener = app.listen(port, () => {
    const port = listener.address().port;
    console.log(`Server running at http://127.0.0.1:${port}`);
});
