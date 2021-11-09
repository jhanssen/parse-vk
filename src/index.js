import { promisify } from "util";
import { readFile as readFileCb } from "fs";
import minimist from "minimist";

const readFile = promisify(readFileCb);
const argv = minimist(process.argv.slice(2));

const data = {
    items: [],
    current: [],
    tops: {},
    argNo: 0
};

function varName(name) {
    let ret = name;
    const br = ret.indexOf('[');
    if (br !== -1) {
        ret = ret.substr(0, br);
    }
    ret += `_${++data.argNo}`;
    return ret;
}

function varValue(val, argVarVals) {
    if (val in argVarVals) {
        return argVarVals[val];
    }
    const ptrrx = /^0x[0-9a-f]+$/;
    if (ptrrx.test(val)) {
        // find in tops
        if (!(val in data.tops)) {
            console.log("hm", data.tops, argVarVals);
            throw new Error(`pointer ${val} not found in tops`);
        }
        return data.tops[val].varName;
    }
    const enumrx = /^[0-9]+ \(([^)]+)\)$/;
    let m = enumrx.exec(val);
    if (m) {
        return m[1];
    }
    const constrx = /^([A-Z][A-Z0-9_]*) \([0-9]+\)$/;
    m = constrx.exec(val);
    if (m) {
        return m[1];
    }
    return val;
}

function currentItem() {
    return data.current[data.current.length - 1];
}

function currentArg() {
    return currentItem().args[currentItem().args.length - 1];
}

async function writeTops(emit) {
    for (const key of Object.keys(data.tops)) {
        const top = data.tops[key];
        await emit(`${top.type} ${top.varName} = reinterpret_cast<${top.type}>(${top.value});`);
    }
}

function writeArgValues(item, argVarNames, argVarVals, emit) {
    const keys = Object.keys(item.argValues);
    const numKeys = keys.length;
    for (let kidx = 0; kidx < numKeys; ++kidx) {
        const key = keys[kidx];
        const argValue = item.argValues[key];
        writeArgValues(argValue, argVarNames, argVarVals, emit);

        // find the type from args
        const idx = item.args.findIndex(item => item.name === key);
        if (idx === -1) {
            throw new Error(`couldn't find ${key} in args`);
        }
        let vn;
        if (key in argVarNames) {
            vn = argVarNames[key];
        } else {
            vn = varName(key);
            argVarNames[key] = vn;
        }
        argVarVals[item.args[idx].value] = vn;
        emit(`${item.args[idx].type} ${vn} = {};`);
        for (const arg of argValue.args) {
            emit(`${vn}.${arg.name} = ${varValue(arg.value, argVarVals)};`);
        }
    }
}

function writeCall(item, argVarNames, argVarVals, emit) {
    // build args
    let args = "";
    let numArgs = item.args.length;
    for (let i = 0; i < numArgs; ++i) {
        args += varValue(item.args[i].value, argVarVals);
        if (i + 1 < numArgs)
            args += ", ";
    }
    emit(`${item.name}(${args});`);
}

async function writeItems(emit) {
    for (const item of data.items) {
        // first, traverse all the way to the leaf argValues and iterate backwards
        const argVarNames = {};
        const argVarVals = {};
        writeArgValues(item, argVarNames, argVarVals, emit);
        // then write the vulkan call
        writeCall(item, argVarNames, argVarVals, emit);
    }
}

async function write(emit) {
    await writeTops(emit);
    await writeItems(emit);
}

async function processTops() {
    const ptrrx = /^0x[0-9a-f]+$/;

    const processTopItem = (item) => {
        let numArgs = item.args.length;
        if (item.name.startsWith("vkCreate") || item.name.startsWith("vkGet"))
            --numArgs;
        for (let aidx = 0; aidx < numArgs; ++aidx) {
            const arg = item.args[aidx];
            if (!(arg.name in item.argValues)) {
                // it's a top arg if the value looks like a pointer
                if (ptrrx.test(arg.value) && !(arg.value in data.tops)) {
                    data.tops[arg.value] = {
                        name: arg.name,
                        type: arg.type,
                        value: arg.value,
                        varName: varName(arg.name)
                    };
                }
            }
        }
        // leaf argValues are also potential top items
        for (const key of Object.keys(item.argValues)) {
            const subitem = item.argValues[key];
            processTopItem(subitem);
        }
    };

    for (const item of data.items) {
        processTopItem(item);
    }
}

function processCurrent(line) {
    //console.log("li", line);
    const lrx = /^(\s+)([^:]+):\s+([^=]+)= ([^:]+):?$/;
    const m = lrx.exec(line);
    if (!m) {
        throw new Error(`current line no match '${line}'`);
    }
    if (m[1].length > currentItem().indent) {
        data.current.push({ name: currentArg().name, args: [], argValues: {}, indent: m[1].length });
    } else if (m[1].length < currentItem().indent) {
        const cur = data.current.pop();
        if (data.current.length === 0) {
            throw new Error(`current went to 0`);
        }
        currentItem().argValues[cur.name] = cur;
    }

    // if we already have one of these args, remove it
    const idx = currentItem().args.findIndex(item => item.name === m[2]);
    if (idx !== -1) {
        currentItem().args.splice(idx, 1);
    }

    currentItem().args.push({
        name: m[2],
        type: m[3].trim(),
        value: m[4]
    });
}

async function parse() {
    if (!argv.file) {
        throw new Error(`need a --file`);
    }

    const filedata = await readFile(argv.file, "utf8");
    const lines = filedata.split("\n");
    const vkrx = /^(vk[^(]+)\(([^)]*)\) returns ([^:]+):$/g;
    for (let line = 0; line < lines.length; ++line) {
        const m = vkrx.exec(lines[line]);
        if (m) {
            const args = m[2].split(", ");
            // console.log(m[1], args);
            data.current.push({ name: m[1], namedArgs: args, ret: m[3], args: [], argValues: {}, indent: 4 });
            while (line + 1 < lines.length) {
                if (lines[line + 1][0] === ' ') {
                    ++line;
                    processCurrent(lines[line]);
                } else {
                    if (data.current.length < 1) {
                        throw new Error(`unexpected current length ${data.current.length}`);
                    }
                    while (data.current.length > 1) {
                        // finalize currents
                        const cur = data.current.pop();
                        currentItem().argValues[cur.name] = cur;
                    }
                    data.items.push(data.current.pop());
                    break;
                }
            }
        }
    }
}

async function emitConsole(str) {
    console.log(str);
}

(async function() {
    await parse();
    await processTops();
    //console.log("top", data.tops);

    await write(emitConsole);
    // await write();
})().then(() => { process.exit(0); }).catch(e => { console.error(e); process.exit(1); });
