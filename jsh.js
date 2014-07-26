var jsh = {};

// when there's a body to speak of, create an empty iframe.
// We'll use its eval function so we can provide scoping without messing up
//with the console itself.
// Of course, you could trivially escape, but you'd need to try in order to do
//that, so it's Good Enough.
window.addEventListener('DOMContentLoaded', function () {
    jsh.evalFrame = document.createElement('iframe');
    jsh.evalFrame.hidden = true;

    //jsh.src = 'evalFrame.html';

    document.body.appendChild(jsh.evalFrame);

    jsh.evalFrame.contentWindow.console = jsh.console;

    jsh.injectedScript = createInjectedScript(jsh.InjectedScriptHost, jsh.evalFrame.contentWindow, 1);
});

jsh.console = {};
['log', 'info', 'warn', 'error'].forEach(function (level) {
    jsh.console[level] = function () {
        var consoleMessage = {
            level  : level,
            type   : level, // TODO: look into what this is

            source : 'console-api', // TODO and this

            stackTrace : jsh.parseLogStackTrace((new Error()).stack),
            timestamp : Date.now() / 1000,

            // TODO: implement
            line : 0,
            column : 0
        };

        consoleMessage.parameters = [].map.call(arguments, jsh.wrapObject, jsh);
        consoleMessage.text = [].join.call(arguments, ' ');

        var message = {
            method : 'Console.messageAdded',
            params : { message : consoleMessage }
        };

        window.top.InspectorBackend.connection().dispatch(message);
    };
});

// Takes a strung stack trace (err.stack) and makes sense out of it: Extracts
//function names, line and column numbers.
jsh.parseLogStackTrace = function (stack) {
    /*
    The stack trace in Chrome looks something like:
    Error
        at Object.jsh.console.(anonymous function) [as log] (http://url/jsh.js:line:col)
        at foo (eval at <anonymous> (http://url/jsh.js:line:col), <anonymous>:line:col)
        at eval (eval at <anonymous> (http://url/jsh.js:line:col), <anonymous>:line:col)
        at eval (native)
        at Object.jsh.evaluateLikeABoss (http://url/jsh.js:line:col)
        at Object.<anonymous> (http://url/sdk/InspectorBackend.js:line:col)

    We want to do away with the first two lines.
    */
    var stackLines = stack.split('\n').slice(2);

    return stackLines.map(parseLine);

    function parseLine (line) {
        // at obj.funcName (crap)
        var funcMatch = /\s*at (\S+)/.exec(line) || ['', ''];

        // (crap:line:column)
        var positionMatch = /:(\d+):(\d+)\)$/.exec(line) || ['', '', ''];

        return {
            functionName : funcMatch[1],
            lineNumber   : Number(positionMatch[1]),
            columnNumber : Number(positionMatch[2]),

            // protocol stuff.
            scriptId : 0,
            url : ''
        };
    }
};

jsh.eval = function (code) {
    return jsh.evalFrame.contentWindow.eval(code)
};

jsh.evaluateLikeABoss = function (params) {
    console.log(params);
    var ret, result;

    try {
        result = jsh.eval(params.expression);

        ret = {
            result    : jsh.wrapObject(result, params.objectGroup, true, params.generatePreview),
            wasThrown : false,
            __proto__ : null
        };
    }
    catch (e) {
        console.error(e);
        ret = this.injectedScript._createThrownValue(e, params.objectGroup);
    }

    return ret;
};

// injectedScript indirections

/**
    Calls a function on an object (shocking?). Returns the function's return.
    Sometimes, I like to dress up like a strawberry.

    params = {
        functionDeclaration : function code to call
        objectId      : internal object id to call the function on
        arguments     : arguments to pass the function
        returnByValue : yeah...
    }
*/
jsh.callFunctionOn = function (params) {
    var objectId = params.objectId,
        func     = params.functionDeclaration,
        args     = params.arguments,
        byVal    = !!params.returnByValue;

    return this.injectedScript.callFunctionOn(objectId, func, args, byVal);
};

/**
    Wraps an object so it'll be deemed worthy for the console.

    It's simple when the argument is simple...

    > wrapObject(4)
    {
        "type": "number",
        "value": 4,
        "description": "4"
    }

    ...but gets more complex as the arguments get complex...

    > wrapObject({})
    {
        "type": "object",
        "objectId": "{\"injectedScriptId\":1,\"id\":4}",
        "className": "Object",
        "description": "Object",
        "preview": {
            "lossless": false,
            "overflow": false,
            "properties": []
        }
    }

    The objectId above is what'll be used to reference the object in later
    times. Let's look at one with actual properties:

    {
        "type": "object",
        "objectId": "{\"injectedScriptId\":1,\"id\":5}",
        "className": "Object",
        "description": "Object",
        "preview": {
            "lossless": false,
            "overflow": false,
            "properties": [
                {
                    "name": "a",
                    "type": "number",
                    "value": "4"
                },
                {
                    "name": "b",
                    "type": "object",
                    "value": "Object"
                }
            ]
        }
    }

    Parameters:
        obj: Object to wrap.
        group: ...I'm not sure. Default 'console'.
        generatePreview: Whether to attach the preview property. Default true.
*/
jsh.wrapObject = function (obj, group, generatePreview) {
    if (arguments.length === 1) {
        group = 'console';
        generatePreview = true;
    }

    return this.injectedScript.wrapObject(obj, group, true, generatePreview);
};

jsh.getProperties = function (params) {
    var id            = params.objectId,
        ownProps      = params.ownProperties,
        accessorsOnly = params.accessorPropertiesOnly;

    return {
        result : this.injectedScript.getProperties(id, ownProps, accessorsOnly)
    };
};

// InjectedScript depends on some native methods. This is their simulation.
jsh.InjectedScriptHost = {
    eval : jsh.eval,

    isHTMLAllCollection : function (suspect) {
        return suspect === document.all ||
            suspect === jsh.evalFrame.contentDocument.all;
    },

    type : function (obj) {
        /*
        V8InjectedScriptHost::typeMethodCustom (found in
        chromium/third_party/WebKit/Source/bindings/core/v8/custom/V8InjectedScriptHostCustom.cpp)
        does a bunch of value->IsType() calls (->isString, ->isArray etc), and
        then some V8Type::hasInstance (V8Mode::hasInstance, V8NodeList::hasInstance, ...)

        isArrayLike above got patched to capture the array ones.

        The best we can repliate that is a Object..toString call.
        */

        // [object Type]
        //         ^--^
        var exposedType = ({}).toString.call(obj).slice(8, -1);
        var verbatim = ['String', 'Array', 'Boolean', 'Number', 'Date', 'RegExp'];

        if (verbatim.indexOf(exposedType) > -1) {
            return exposedType.toLowerCase();
        }

        // The only thing left is checking for Node.
        // Since the object came from another frame, we can't use instanceof.
        //This is "good enough".
        if (obj.hasOwnProperty('nodeType') && obj.hasOwnProperty('ATTRIBUTE_NODE')) {
            return 'node';
        }

        var arrayTypes = [
            'Int8Array', 'Int16Array', 'Int32Array',
            'Uint8Array', 'Uint16Array', 'Uint32Array',
            'Uint8ClampedArray',
            'Float32Array', 'Float64Array'
        ];
        // forgot anything?

        if (arrayTypes.indexOf(obj) > -1) {
            return isFinite(obj.length);
        }
    },

    internalConstructorName : function (subject) {
        // The actual implementation does some...weird stuff.
        // Fuck that.

        var type = ({}).toString.call(subject).slice(8, -1);
        if (subject !== Object(subject)) {
            return type;
        }

        if (subject.constructor) {
            return subject.constructor.name;
        }
        return type;
    },

    suppressWarningsAndCall : function (obj, method) {
        // yeah, fuck actual implementation.
        var args = [].slice.call(arguments, 2);
        return method.apply(obj, args);
    },
};

/*
                           _____ _            _____
                          |_   _| |          |  __ \
                            | | | |__   ___  | |  \/ __ _ _ __ ___   ___
                            | | | '_ \ / _ \ | | __ / _` | '_ ` _ \ / _ \
                            | | | | | |  __/ | |_\ \ (_| | | | | | |  __/
                            \_/ |_| |_|\___|  \____/\__,_|_| |_| |_|\___|

*/
