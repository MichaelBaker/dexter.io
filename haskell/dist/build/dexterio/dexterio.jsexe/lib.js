/* node.js support for GHCJS */
if(typeof require !== 'undefined') {
  var h$nodeFs = require('fs');
}

// node.js global objects don't work as Closure Library expects
var goog = {};
goog.global = this;
goog.global.goog = goog;
goog.global.CLOSURE_NO_DEPS = true;

// SpiderMonkey support

// we don't have console, but we do have print
if(this['print'] !== undefined && this['console'] === undefined) {
  this['console'] = { log: this['print'] };
}

// jsbn checks this
if(this['navigator'] === undefined) {
  navigator = { appName: 'none' };
}

// IE 8 doesn't support Date.now(), shim it
if (!Date.now) {
  Date.now = function now() {
    return +(new Date);
  };
}

/*
 Copyright (c) 2010, Linden Research, Inc.
 Copyright (c) 2012, Joshua Bell

 Permission is hereby granted, free of charge, to any person obtaining a copy
 of this software and associated documentation files (the "Software"), to deal
 in the Software without restriction, including without limitation the rights
 to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 copies of the Software, and to permit persons to whom the Software is
 furnished to do so, subject to the following conditions:

 The above copyright notice and this permission notice shall be included in
 all copies or substantial portions of the Software.

 THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 THE SOFTWARE.
 $/LicenseInfo$
 */

// Original can be found at:  https://bitbucket.org/lindenlab/llsd
// Modifications by Joshua Bell inexorabletash@gmail.com
//  * Restructure the creation of types and exporting to global namespace
//  * Allow no arguments to DataView constructor
//  * Work cross-frame with native arrays/shimmed DataView
//  * Corrected Object.defineProperty shim for IE8
//  * Correct offset when taking subarray of subarray

// ES3/ES5 implementation of the Krhonos TypedArray Working Draft (work in progress):
//   Ref: https://cvs.khronos.org/svn/repos/registry/trunk/public/webgl/doc/spec/TypedArray-spec.html
//   Date: 2011-02-01
//
// Variations:
//  * Float/Double -> Float32/Float64, per WebGL-Public mailing list conversations (post 5/17)
//  * Allows typed_array.get/set() as alias for subscripts (typed_array[])


(function (global) {
  "use strict";

  var USE_NATIVE_IF_AVAILABLE = true;

  // Approximations of internal ECMAScript conversion functions
  var ECMAScript = (function () {
    // Stash a copy in case other scripts modify these
    var opts = Object.prototype.toString,
        ophop = Object.prototype.hasOwnProperty;

    return {
      // Class returns internal [[Class]] property, used to avoid cross-frame instanceof issues:
      Class: function(v) { return opts.call(v).replace(/^\[object *|\]$/g, ''); },
      HasProperty: function(o, p) { return p in o; },
      HasOwnProperty: function(o, p) { return ophop.call(o, p); },
      IsCallable: function(o) { return typeof o === 'function'; },
      ToInt32: function (v) { return v >> 0; },
      ToUint32: function (v) { return v >>> 0; }
    };
  }());

  // Create an INDEX_SIZE_ERR event - intentionally induces a DOM error if possible
  function new_INDEX_SIZE_ERR() {
    try {
      if (document) {
        // raises DOMException(INDEX_SIZE_ERR)
        document.createTextNode("").splitText(1);
      }
      return new RangeError("INDEX_SIZE_ERR");
    } catch (e) {
      return e;
    }
  }

  // ES5: lock down object properties
  function configureProperties(obj) {
    if (Object.getOwnPropertyNames && Object.defineProperty) {
      var props = Object.getOwnPropertyNames(obj), i;
      for (i = 0; i < props.length; i += 1) {
        Object.defineProperty(obj, props[i], {
          value: obj[props[i]],
          writable: false,
          enumerable: false,
          configurable: false
        });
      }
    }
  }

  // emulate ES5 getter/setter API using legacy APIs
  // http://blogs.msdn.com/b/ie/archive/2010/09/07/transitioning-existing-code-to-the-es5-getter-setter-apis.aspx
  // (second clause tests for Object.defineProperty() in IE<9 that only supports extending DOM prototypes, but
  // note that IE<9 does not support __defineGetter__ or __defineSetter__ so it just renders the method harmless)
  if (!Object.defineProperty ||
       !(function () { try { Object.defineProperty({}, 'x', {}); return true; } catch (e) { return false; } } ())) {
    Object.defineProperty = function (o, p, desc) {
      if (!o === Object(o)) { throw new TypeError("Object.defineProperty called on non-object"); }
      if (ECMAScript.HasProperty(desc, 'get') && Object.prototype.__defineGetter__) { Object.prototype.__defineGetter__.call(o, p, desc.get); }
      if (ECMAScript.HasProperty(desc, 'set') && Object.prototype.__defineSetter__) { Object.prototype.__defineSetter__.call(o, p, desc.set); }
      if (ECMAScript.HasProperty(desc, 'value')) { o[p] = desc.value; }
      return o;
    };
  }

  if (!Object.getOwnPropertyNames) {
    Object.getOwnPropertyNames = function getOwnPropertyNames(o) {
      if (o !== Object(o)) { throw new TypeError("Object.getOwnPropertyNames called on non-object"); }
      var props = [], p;
      for (p in o) {
        if (ECMAScript.HasOwnProperty(o, p)) {
          props.push(p);
        }
      }
      return props;
    };
  }

  // ES5: Make obj[index] an alias for obj._getter(index)/obj._setter(index, value)
  // for index in 0 ... obj.length
  function makeArrayAccessors(obj) {
    if (!Object.defineProperty) { return; }

    function makeArrayAccessor(index) {
      Object.defineProperty(obj, index, {
        'get': function () { return obj._getter(index); },
        'set': function (v) { obj._setter(index, v); },
        enumerable: true,
        configurable: false
      });
    }

    var i;
    for (i = 0; i < obj.length; i += 1) {
      makeArrayAccessor(i);
    }
  }

  // Internal conversion functions:
  //    pack<Type>()   - take a number (interpreted as Type), output a byte array
  //    unpack<Type>() - take a byte array, output a Type-like number

  function as_signed(value, bits) { var s = 32 - bits; return (value << s) >> s; }
  function as_unsigned(value, bits) { var s = 32 - bits; return (value << s) >>> s; }

  function packInt8(n) { return [n & 0xff]; }
  function unpackInt8(bytes) { return as_signed(bytes[0], 8); }

  function packUint8(n) { return [n & 0xff]; }
  function unpackUint8(bytes) { return as_unsigned(bytes[0], 8); }

  function packUint8Clamped(n) { n = Math.round(Number(n)); return [n < 0 ? 0 : n > 0xff ? 0xff : n & 0xff]; }

  function packInt16(n) { return [(n >> 8) & 0xff, n & 0xff]; }
  function unpackInt16(bytes) { return as_signed(bytes[0] << 8 | bytes[1], 16); }

  function packUint16(n) { return [(n >> 8) & 0xff, n & 0xff]; }
  function unpackUint16(bytes) { return as_unsigned(bytes[0] << 8 | bytes[1], 16); }

  function packInt32(n) { return [(n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]; }
  function unpackInt32(bytes) { return as_signed(bytes[0] << 24 | bytes[1] << 16 | bytes[2] << 8 | bytes[3], 32); }

  function packUint32(n) { return [(n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]; }
  function unpackUint32(bytes) { return as_unsigned(bytes[0] << 24 | bytes[1] << 16 | bytes[2] << 8 | bytes[3], 32); }

  function packIEEE754(v, ebits, fbits) {

    var bias = (1 << (ebits - 1)) - 1,
        s, e, f, ln,
        i, bits, str, bytes;

    // Compute sign, exponent, fraction
    if (v !== v) {
      // NaN
      // http://dev.w3.org/2006/webapi/WebIDL/#es-type-mapping
      e = (1 << bias) - 1; f = Math.pow(2, fbits - 1); s = 0;
    } else if (v === Infinity || v === -Infinity) {
      e = (1 << bias) - 1; f = 0; s = (v < 0) ? 1 : 0;
    } else if (v === 0) {
      e = 0; f = 0; s = (1 / v === -Infinity) ? 1 : 0;
    } else {
      s = v < 0;
      v = Math.abs(v);

      if (v >= Math.pow(2, 1 - bias)) {
        // Normalized
        ln = Math.min(Math.floor(Math.log(v) / Math.LN2), bias);
        e = ln + bias;
        f = Math.round(v * Math.pow(2, fbits - ln) - Math.pow(2, fbits));
      } else {
        // Denormalized
        e = 0;
        f = Math.round(v / Math.pow(2, 1 - bias - fbits));
      }
    }

    // Pack sign, exponent, fraction
    bits = [];
    for (i = fbits; i; i -= 1) { bits.push(f % 2 ? 1 : 0); f = Math.floor(f / 2); }
    for (i = ebits; i; i -= 1) { bits.push(e % 2 ? 1 : 0); e = Math.floor(e / 2); }
    bits.push(s ? 1 : 0);
    bits.reverse();
    str = bits.join('');

    // Bits to bytes
    bytes = [];
    while (str.length) {
      bytes.push(parseInt(str.substring(0, 8), 2));
      str = str.substring(8);
    }
    return bytes;
  }

  function unpackIEEE754(bytes, ebits, fbits) {

    // Bytes to bits
    var bits = [], i, j, b, str,
        bias, s, e, f;

    for (i = bytes.length; i; i -= 1) {
      b = bytes[i - 1];
      for (j = 8; j; j -= 1) {
        bits.push(b % 2 ? 1 : 0); b = b >> 1;
      }
    }
    bits.reverse();
    str = bits.join('');

    // Unpack sign, exponent, fraction
    bias = (1 << (ebits - 1)) - 1;
    s = parseInt(str.substring(0, 1), 2) ? -1 : 1;
    e = parseInt(str.substring(1, 1 + ebits), 2);
    f = parseInt(str.substring(1 + ebits), 2);

    // Produce number
    if (e === (1 << ebits) - 1) {
      return f !== 0 ? NaN : s * Infinity;
    } else if (e > 0) {
      // Normalized
      return s * Math.pow(2, e - bias) * (1 + f / Math.pow(2, fbits));
    } else if (f !== 0) {
      // Denormalized
      return s * Math.pow(2, -(bias - 1)) * (f / Math.pow(2, fbits));
    } else {
      return s < 0 ? -0 : 0;
    }
  }

  function unpackFloat64(b) { return unpackIEEE754(b, 11, 52); }
  function packFloat64(v) { return packIEEE754(v, 11, 52); }
  function unpackFloat32(b) { return unpackIEEE754(b, 8, 23); }
  function packFloat32(v) { return packIEEE754(v, 8, 23); }


  //
  // 3 The ArrayBuffer Type
  //

  (function () {

    /** @constructor */
    var ArrayBuffer = function ArrayBuffer(length) {
      length = ECMAScript.ToInt32(length);
      if (length < 0) { throw new RangeError('ArrayBuffer size is not a small enough positive integer.'); }

      this.byteLength = length;
      this._bytes = [];
      this._bytes.length = length;

      var i;
      for (i = 0; i < this.byteLength; i += 1) {
        this._bytes[i] = 0;
      }

      configureProperties(this);
    };


    //
    // 4 The ArrayBufferView Type
    //

    // NOTE: this constructor is not exported
    /** @constructor */
    var ArrayBufferView = function ArrayBufferView() {
      //this.buffer = null;
      //this.byteOffset = 0;
      //this.byteLength = 0;
    };

    //
    // 5 The Typed Array View Types
    //

    function makeTypedArrayConstructor(bytesPerElement, pack, unpack) {
      // Each TypedArray type requires a distinct constructor instance with
      // identical logic, which this produces.

      var ctor;
      ctor = function (buffer, byteOffset, length) {
        var array, sequence, i, s;

        if (!arguments.length || typeof arguments[0] === 'number') {
          // Constructor(unsigned long length)
          this.length = ECMAScript.ToInt32(arguments[0]);
          if (length < 0) { throw new RangeError('ArrayBufferView size is not a small enough positive integer.'); }

          this.byteLength = this.length * this.BYTES_PER_ELEMENT;
          this.buffer = new ArrayBuffer(this.byteLength);
          this.byteOffset = 0;
        } else if (typeof arguments[0] === 'object' && arguments[0].constructor === ctor) {
          // Constructor(TypedArray array)
          array = arguments[0];

          this.length = array.length;
          this.byteLength = this.length * this.BYTES_PER_ELEMENT;
          this.buffer = new ArrayBuffer(this.byteLength);
          this.byteOffset = 0;

          for (i = 0; i < this.length; i += 1) {
            this._setter(i, array._getter(i));
          }
        } else if (typeof arguments[0] === 'object' &&
                   !(arguments[0] instanceof ArrayBuffer || ECMAScript.Class(arguments[0]) === 'ArrayBuffer')) {
          // Constructor(sequence<type> array)
          sequence = arguments[0];

          this.length = ECMAScript.ToUint32(sequence.length);
          this.byteLength = this.length * this.BYTES_PER_ELEMENT;
          this.buffer = new ArrayBuffer(this.byteLength);
          this.byteOffset = 0;

          for (i = 0; i < this.length; i += 1) {
            s = sequence[i];
            this._setter(i, Number(s));
          }
        } else if (typeof arguments[0] === 'object' &&
                   (arguments[0] instanceof ArrayBuffer || ECMAScript.Class(arguments[0]) === 'ArrayBuffer')) {
          // Constructor(ArrayBuffer buffer,
          //             optional unsigned long byteOffset, optional unsigned long length)
          this.buffer = buffer;

          this.byteOffset = ECMAScript.ToUint32(byteOffset);
          if (this.byteOffset > this.buffer.byteLength) {
            throw new_INDEX_SIZE_ERR(); // byteOffset out of range
          }

          if (this.byteOffset % this.BYTES_PER_ELEMENT) {
            // The given byteOffset must be a multiple of the element
            // size of the specific type, otherwise an exception is raised.
            //throw new_INDEX_SIZE_ERR();
            throw new RangeError("ArrayBuffer length minus the byteOffset is not a multiple of the element size.");
          }

          if (arguments.length < 3) {
            this.byteLength = this.buffer.byteLength - this.byteOffset;

            if (this.byteLength % this.BYTES_PER_ELEMENT) {
              throw new_INDEX_SIZE_ERR(); // length of buffer minus byteOffset not a multiple of the element size
            }
            this.length = this.byteLength / this.BYTES_PER_ELEMENT;
          } else {
            this.length = ECMAScript.ToUint32(length);
            this.byteLength = this.length * this.BYTES_PER_ELEMENT;
          }

          if ((this.byteOffset + this.byteLength) > this.buffer.byteLength) {
            throw new_INDEX_SIZE_ERR(); // byteOffset and length reference an area beyond the end of the buffer
          }
        } else {
          throw new TypeError("Unexpected argument type(s)");
        }

        this.constructor = ctor;

        configureProperties(this);
        makeArrayAccessors(this);
      };

      ctor.prototype = new ArrayBufferView();
      ctor.prototype.BYTES_PER_ELEMENT = bytesPerElement;
      ctor.prototype._pack = pack;
      ctor.prototype._unpack = unpack;
      ctor.BYTES_PER_ELEMENT = bytesPerElement;

      // getter type (unsigned long index);
      ctor.prototype._getter = function (index) {
        if (arguments.length < 1) { throw new SyntaxError("Not enough arguments"); }

        index = ECMAScript.ToUint32(index);
        if (index >= this.length) {
          //throw new_INDEX_SIZE_ERR(); // Array index out of range
          return (void 0); // undefined
        }

        var bytes = [], i, o;
        for (i = 0, o = this.byteOffset + index * this.BYTES_PER_ELEMENT;
             i < this.BYTES_PER_ELEMENT;
             i += 1, o += 1) {
          bytes.push(this.buffer._bytes[o]);
        }
        return this._unpack(bytes);
      };

      // NONSTANDARD: convenience alias for getter: type get(unsigned long index);
      ctor.prototype.get = ctor.prototype._getter;

      // setter void (unsigned long index, type value);
      ctor.prototype._setter = function (index, value) {
        if (arguments.length < 2) { throw new SyntaxError("Not enough arguments"); }

        index = ECMAScript.ToUint32(index);
        if (index >= this.length) {
          //throw new_INDEX_SIZE_ERR(); // Array index out of range
          return;
        }

        var bytes = this._pack(value), i, o;
        for (i = 0, o = this.byteOffset + index * this.BYTES_PER_ELEMENT;
             i < this.BYTES_PER_ELEMENT;
             i += 1, o += 1) {
          this.buffer._bytes[o] = bytes[i];
        }
      };

      // void set(TypedArray array, optional unsigned long offset);
      // void set(sequence<type> array, optional unsigned long offset);
      ctor.prototype.set = function (index, value) {
        if (arguments.length < 1) { throw new SyntaxError("Not enough arguments"); }
        var array, sequence, offset, len,
            i, s, d,
            byteOffset, byteLength, tmp;

        if (typeof arguments[0] === 'object' && arguments[0].constructor === this.constructor) {
          // void set(TypedArray array, optional unsigned long offset);
          array = arguments[0];
          offset = ECMAScript.ToUint32(arguments[1]);

          if (offset + array.length > this.length) {
            throw new_INDEX_SIZE_ERR(); // Offset plus length of array is out of range
          }

          byteOffset = this.byteOffset + offset * this.BYTES_PER_ELEMENT;
          byteLength = array.length * this.BYTES_PER_ELEMENT;

          if (array.buffer === this.buffer) {
            tmp = [];
            for (i = 0, s = array.byteOffset; i < byteLength; i += 1, s += 1) {
              tmp[i] = array.buffer._bytes[s];
            }
            for (i = 0, d = byteOffset; i < byteLength; i += 1, d += 1) {
              this.buffer._bytes[d] = tmp[i];
            }
          } else {
            for (i = 0, s = array.byteOffset, d = byteOffset;
                 i < byteLength; i += 1, s += 1, d += 1) {
              this.buffer._bytes[d] = array.buffer._bytes[s];
            }
          }
        } else if (typeof arguments[0] === 'object' && typeof arguments[0].length !== 'undefined') {
          // void set(sequence<type> array, optional unsigned long offset);
          sequence = arguments[0];
          len = ECMAScript.ToUint32(sequence.length);
          offset = ECMAScript.ToUint32(arguments[1]);

          if (offset + len > this.length) {
            throw new_INDEX_SIZE_ERR(); // Offset plus length of array is out of range
          }

          for (i = 0; i < len; i += 1) {
            s = sequence[i];
            this._setter(offset + i, Number(s));
          }
        } else {
          throw new TypeError("Unexpected argument type(s)");
        }
      };

      // TypedArray subarray(long begin, optional long end);
      ctor.prototype.subarray = function (start, end) {
        function clamp(v, min, max) { return v < min ? min : v > max ? max : v; }

        start = ECMAScript.ToInt32(start);
        end = ECMAScript.ToInt32(end);

        if (arguments.length < 1) { start = 0; }
        if (arguments.length < 2) { end = this.length; }

        if (start < 0) { start = this.length + start; }
        if (end < 0) { end = this.length + end; }

        start = clamp(start, 0, this.length);
        end = clamp(end, 0, this.length);

        var len = end - start;
        if (len < 0) {
          len = 0;
        }

        return new this.constructor(
          this.buffer, this.byteOffset + start * this.BYTES_PER_ELEMENT, len);
      };

      return ctor;
    }

    var Int8Array = makeTypedArrayConstructor(1, packInt8, unpackInt8);
    var Uint8Array = makeTypedArrayConstructor(1, packUint8, unpackUint8);
    var Uint8ClampedArray = makeTypedArrayConstructor(1, packUint8Clamped, unpackUint8);
    var Int16Array = makeTypedArrayConstructor(2, packInt16, unpackInt16);
    var Uint16Array = makeTypedArrayConstructor(2, packUint16, unpackUint16);
    var Int32Array = makeTypedArrayConstructor(4, packInt32, unpackInt32);
    var Uint32Array = makeTypedArrayConstructor(4, packUint32, unpackUint32);
    var Float32Array = makeTypedArrayConstructor(4, packFloat32, unpackFloat32);
    var Float64Array = makeTypedArrayConstructor(8, packFloat64, unpackFloat64);

    if (USE_NATIVE_IF_AVAILABLE) {
      global.ArrayBuffer = global.ArrayBuffer || ArrayBuffer;
      global.Int8Array = global.Int8Array || Int8Array;
      global.Uint8Array = global.Uint8Array || Uint8Array;
      global.Uint8ClampedArray = global.Uint8ClampedArray || Uint8ClampedArray;
      global.Int16Array = global.Int16Array || Int16Array;
      global.Uint16Array = global.Uint16Array || Uint16Array;
      global.Int32Array = global.Int32Array || Int32Array;
      global.Uint32Array = global.Uint32Array || Uint32Array;
      global.Float32Array = global.Float32Array || Float32Array;
      global.Float64Array = global.Float64Array || Float64Array;
    } else {
      global.ArrayBuffer = ArrayBuffer;
      global.Int8Array = Int8Array;
      global.Uint8Array = Uint8Array;
      global.Uint8ClampedArray = Uint8ClampedArray;
      global.Int16Array = Int16Array;
      global.Uint16Array = Uint16Array;
      global.Int32Array = Int32Array;
      global.Uint32Array = Uint32Array;
      global.Float32Array = Float32Array;
      global.Float64Array = Float64Array;
    }
  } ());

  //
  // 6 The DataView View Type
  //

  (function () {
    function r(array, index) {
      return ECMAScript.IsCallable(array.get) ? array.get(index) : array[index];
    }


    var IS_BIG_ENDIAN = (function () {
      var u16array = new Uint16Array([0x1234]),
          u8array = new Uint8Array(u16array.buffer);
      return r(u8array, 0) === 0x12;
    } ());

    // Constructor(ArrayBuffer buffer,
    //             optional unsigned long byteOffset,
    //             optional unsigned long byteLength)
    /** @constructor */
    var DataView = function DataView(buffer, byteOffset, byteLength) {
      if (arguments.length === 0) {
        buffer = new ArrayBuffer(0);
      } else if (!(buffer instanceof ArrayBuffer || ECMAScript.Class(buffer) === 'ArrayBuffer')) {
        throw new TypeError("TypeError");
      }

      this.buffer = buffer || new ArrayBuffer(0);

      this.byteOffset = ECMAScript.ToUint32(byteOffset);
      if (this.byteOffset > this.buffer.byteLength) {
        throw new_INDEX_SIZE_ERR(); // byteOffset out of range
      }

      if (arguments.length < 3) {
        this.byteLength = this.buffer.byteLength - this.byteOffset;
      } else {
        this.byteLength = ECMAScript.ToUint32(byteLength);
      }

      if ((this.byteOffset + this.byteLength) > this.buffer.byteLength) {
        throw new_INDEX_SIZE_ERR(); // byteOffset and length reference an area beyond the end of the buffer
      }

      configureProperties(this);
    };

    // TODO: Reintroduce this to get correct hierarchy
    //if (typeof ArrayBufferView === 'function') {
    //  DataView.prototype = new ArrayBufferView();
    //}

    function makeDataView_getter(arrayType) {
      return function (byteOffset, littleEndian) {

        byteOffset = ECMAScript.ToUint32(byteOffset);

        if (byteOffset + arrayType.BYTES_PER_ELEMENT > this.byteLength) {
          throw new_INDEX_SIZE_ERR(); // Array index out of range
        }
        byteOffset += this.byteOffset;

        var uint8Array = new Uint8Array(this.buffer, byteOffset, arrayType.BYTES_PER_ELEMENT),
            bytes = [], i;
        for (i = 0; i < arrayType.BYTES_PER_ELEMENT; i += 1) {
          bytes.push(r(uint8Array, i));
        }

        if (Boolean(littleEndian) === Boolean(IS_BIG_ENDIAN)) {
          bytes.reverse();
        }

        return r(new arrayType(new Uint8Array(bytes).buffer), 0);
      };
    }

    DataView.prototype.getUint8 = makeDataView_getter(Uint8Array);
    DataView.prototype.getInt8 = makeDataView_getter(Int8Array);
    DataView.prototype.getUint16 = makeDataView_getter(Uint16Array);
    DataView.prototype.getInt16 = makeDataView_getter(Int16Array);
    DataView.prototype.getUint32 = makeDataView_getter(Uint32Array);
    DataView.prototype.getInt32 = makeDataView_getter(Int32Array);
    DataView.prototype.getFloat32 = makeDataView_getter(Float32Array);
    DataView.prototype.getFloat64 = makeDataView_getter(Float64Array);

    function makeDataView_setter(arrayType) {
      return function (byteOffset, value, littleEndian) {

        byteOffset = ECMAScript.ToUint32(byteOffset);
        if (byteOffset + arrayType.BYTES_PER_ELEMENT > this.byteLength) {
          throw new_INDEX_SIZE_ERR(); // Array index out of range
        }

        // Get bytes
        var typeArray = new arrayType([value]),
            byteArray = new Uint8Array(typeArray.buffer),
            bytes = [], i, byteView;

        for (i = 0; i < arrayType.BYTES_PER_ELEMENT; i += 1) {
          bytes.push(r(byteArray, i));
        }

        // Flip if necessary
        if (Boolean(littleEndian) === Boolean(IS_BIG_ENDIAN)) {
          bytes.reverse();
        }

        // Write them
        byteView = new Uint8Array(this.buffer, byteOffset, arrayType.BYTES_PER_ELEMENT);
        byteView.set(bytes);
      };
    }

    DataView.prototype.setUint8 = makeDataView_setter(Uint8Array);
    DataView.prototype.setInt8 = makeDataView_setter(Int8Array);
    DataView.prototype.setUint16 = makeDataView_setter(Uint16Array);
    DataView.prototype.setInt16 = makeDataView_setter(Int16Array);
    DataView.prototype.setUint32 = makeDataView_setter(Uint32Array);
    DataView.prototype.setInt32 = makeDataView_setter(Int32Array);
    DataView.prototype.setFloat32 = makeDataView_setter(Float32Array);
    DataView.prototype.setFloat64 = makeDataView_setter(Float64Array);

    if (USE_NATIVE_IF_AVAILABLE) {
      global.DataView = global.DataView || DataView;
    } else {
      global.DataView = DataView;
    }

  } ());

} (this));

// add exported things to global again, run this after all node modules
/*
var h$glbl = this;
for(p in exports) { 
//  console.log("exporting: " + p);
//  console.log("type: " + (typeof this[p]));
  if(typeof this[p] === 'undefined') {
    h$glbl[p] = exports[p];
  }
}
*/
if(typeof exports !== 'undefined') {
  if(typeof WeakMap === 'undefined') {
    WeakMap = exports.WeakMap;
  }
//  var Map     = exports.Map;
//  var Set     = exports.Set;
}


// Copyright 2006 The Closure Library Authors. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS-IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * @fileoverview Bootstrap for the Google JS Library (Closure).
 *
 * In uncompiled mode base.js will write out Closure's deps file, unless the
 * global <code>CLOSURE_NO_DEPS</code> is set to true.  This allows projects to
 * include their own deps file(s) from different locations.
 *
 *
 * @provideGoog
 */


/**
 * @define {boolean} Overridden to true by the compiler when --closure_pass
 *     or --mark_as_compiled is specified.
 */
var COMPILED = false;


/**
 * Base namespace for the Closure library.  Checks to see goog is
 * already defined in the current scope before assigning to prevent
 * clobbering if base.js is loaded more than once.
 *
 * @const
 */
var goog = goog || {}; // Identifies this file as the Closure base.


/**
 * Reference to the global context.  In most cases this will be 'window'.
 */
goog.global = this;


/**
 * @define {boolean} DEBUG is provided as a convenience so that debugging code
 * that should not be included in a production js_binary can be easily stripped
 * by specifying --define goog.DEBUG=false to the JSCompiler. For example, most
 * toString() methods should be declared inside an "if (goog.DEBUG)" conditional
 * because they are generally used for debugging purposes and it is difficult
 * for the JSCompiler to statically determine whether they are used.
 */
goog.DEBUG = true;


/**
 * @define {string} LOCALE defines the locale being used for compilation. It is
 * used to select locale specific data to be compiled in js binary. BUILD rule
 * can specify this value by "--define goog.LOCALE=<locale_name>" as JSCompiler
 * option.
 *
 * Take into account that the locale code format is important. You should use
 * the canonical Unicode format with hyphen as a delimiter. Language must be
 * lowercase, Language Script - Capitalized, Region - UPPERCASE.
 * There are few examples: pt-BR, en, en-US, sr-Latin-BO, zh-Hans-CN.
 *
 * See more info about locale codes here:
 * http://www.unicode.org/reports/tr35/#Unicode_Language_and_Locale_Identifiers
 *
 * For language codes you should use values defined by ISO 693-1. See it here
 * http://www.w3.org/WAI/ER/IG/ert/iso639.htm. There is only one exception from
 * this rule: the Hebrew language. For legacy reasons the old code (iw) should
 * be used instead of the new code (he), see http://wiki/Main/IIISynonyms.
 */
goog.LOCALE = 'en';  // default to en


/**
 * Creates object stubs for a namespace.  The presence of one or more
 * goog.provide() calls indicate that the file defines the given
 * objects/namespaces.  Build tools also scan for provide/require statements
 * to discern dependencies, build dependency files (see deps.js), etc.
 * @see goog.require
 * @param {string} name Namespace provided by this file in the form
 *     "goog.package.part".
 */
goog.provide = function(name) {
  if (!COMPILED) {
    // Ensure that the same namespace isn't provided twice. This is intended
    // to teach new developers that 'goog.provide' is effectively a variable
    // declaration. And when JSCompiler transforms goog.provide into a real
    // variable declaration, the compiled JS should work the same as the raw
    // JS--even when the raw JS uses goog.provide incorrectly.
    if (goog.isProvided_(name)) {
      throw Error('Namespace "' + name + '" already declared.');
    }
    delete goog.implicitNamespaces_[name];

    var namespace = name;
    while ((namespace = namespace.substring(0, namespace.lastIndexOf('.')))) {
      if (goog.getObjectByName(namespace)) {
        break;
      }
      goog.implicitNamespaces_[namespace] = true;
    }
  }

  goog.exportPath_(name);
};


/**
 * Marks that the current file should only be used for testing, and never for
 * live code in production.
 * @param {string=} opt_message Optional message to add to the error that's
 *     raised when used in production code.
 */
goog.setTestOnly = function(opt_message) {
  if (COMPILED && !goog.DEBUG) {
    opt_message = opt_message || '';
    throw Error('Importing test-only code into non-debug environment' +
                opt_message ? ': ' + opt_message : '.');
  }
};


if (!COMPILED) {

  /**
   * Check if the given name has been goog.provided. This will return false for
   * names that are available only as implicit namespaces.
   * @param {string} name name of the object to look for.
   * @return {boolean} Whether the name has been provided.
   * @private
   */
  goog.isProvided_ = function(name) {
    return !goog.implicitNamespaces_[name] && !!goog.getObjectByName(name);
  };

  /**
   * Namespaces implicitly defined by goog.provide. For example,
   * goog.provide('goog.events.Event') implicitly declares
   * that 'goog' and 'goog.events' must be namespaces.
   *
   * @type {Object}
   * @private
   */
  goog.implicitNamespaces_ = {};
}


/**
 * Builds an object structure for the provided namespace path,
 * ensuring that names that already exist are not overwritten. For
 * example:
 * "a.b.c" -> a = {};a.b={};a.b.c={};
 * Used by goog.provide and goog.exportSymbol.
 * @param {string} name name of the object that this file defines.
 * @param {*=} opt_object the object to expose at the end of the path.
 * @param {Object=} opt_objectToExportTo The object to add the path to; default
 *     is |goog.global|.
 * @private
 */
goog.exportPath_ = function(name, opt_object, opt_objectToExportTo) {
  var parts = name.split('.');
  var cur = opt_objectToExportTo || goog.global;

  // Internet Explorer exhibits strange behavior when throwing errors from
  // methods externed in this manner.  See the testExportSymbolExceptions in
  // base_test.html for an example.
  if (!(parts[0] in cur) && cur.execScript) {
    cur.execScript('var ' + parts[0]);
  }

  // Certain browsers cannot parse code in the form for((a in b); c;);
  // This pattern is produced by the JSCompiler when it collapses the
  // statement above into the conditional loop below. To prevent this from
  // happening, use a for-loop and reserve the init logic as below.

  // Parentheses added to eliminate strict JS warning in Firefox.
  for (var part; parts.length && (part = parts.shift());) {
    if (!parts.length && goog.isDef(opt_object)) {
      // last part and we have an object; use it
      cur[part] = opt_object;
    } else if (cur[part]) {
      cur = cur[part];
    } else {
      cur = cur[part] = {};
    }
  }
};


/**
 * Returns an object based on its fully qualified external name.  If you are
 * using a compilation pass that renames property names beware that using this
 * function will not find renamed properties.
 *
 * @param {string} name The fully qualified name.
 * @param {Object=} opt_obj The object within which to look; default is
 *     |goog.global|.
 * @return {?} The value (object or primitive) or, if not found, null.
 */
goog.getObjectByName = function(name, opt_obj) {
  var parts = name.split('.');
  var cur = opt_obj || goog.global;
  for (var part; part = parts.shift(); ) {
    if (goog.isDefAndNotNull(cur[part])) {
      cur = cur[part];
    } else {
      return null;
    }
  }
  return cur;
};


/**
 * Globalizes a whole namespace, such as goog or goog.lang.
 *
 * @param {Object} obj The namespace to globalize.
 * @param {Object=} opt_global The object to add the properties to.
 * @deprecated Properties may be explicitly exported to the global scope, but
 *     this should no longer be done in bulk.
 */
goog.globalize = function(obj, opt_global) {
  var global = opt_global || goog.global;
  for (var x in obj) {
    global[x] = obj[x];
  }
};


/**
 * Adds a dependency from a file to the files it requires.
 * @param {string} relPath The path to the js file.
 * @param {Array} provides An array of strings with the names of the objects
 *                         this file provides.
 * @param {Array} requires An array of strings with the names of the objects
 *                         this file requires.
 */
goog.addDependency = function(relPath, provides, requires) {
  if (!COMPILED) {
    var provide, require;
    var path = relPath.replace(/\\/g, '/');
    var deps = goog.dependencies_;
    for (var i = 0; provide = provides[i]; i++) {
      deps.nameToPath[provide] = path;
      if (!(path in deps.pathToNames)) {
        deps.pathToNames[path] = {};
      }
      deps.pathToNames[path][provide] = true;
    }
    for (var j = 0; require = requires[j]; j++) {
      if (!(path in deps.requires)) {
        deps.requires[path] = {};
      }
      deps.requires[path][require] = true;
    }
  }
};




// NOTE(nnaze): The debug DOM loader was included in base.js as an orignal
// way to do "debug-mode" development.  The dependency system can sometimes
// be confusing, as can the debug DOM loader's asyncronous nature.
//
// With the DOM loader, a call to goog.require() is not blocking -- the
// script will not load until some point after the current script.  If a
// namespace is needed at runtime, it needs to be defined in a previous
// script, or loaded via require() with its registered dependencies.
// User-defined namespaces may need their own deps file.  See http://go/js_deps,
// http://go/genjsdeps, or, externally, DepsWriter.
// http://code.google.com/closure/library/docs/depswriter.html
//
// Because of legacy clients, the DOM loader can't be easily removed from
// base.js.  Work is being done to make it disableable or replaceable for
// different environments (DOM-less JavaScript interpreters like Rhino or V8,
// for example). See bootstrap/ for more information.


/**
 * @define {boolean} Whether to enable the debug loader.
 *
 * If enabled, a call to goog.require() will attempt to load the namespace by
 * appending a script tag to the DOM (if the namespace has been registered).
 *
 * If disabled, goog.require() will simply assert that the namespace has been
 * provided (and depend on the fact that some outside tool correctly ordered
 * the script).
 */
goog.ENABLE_DEBUG_LOADER = true;


/**
 * Implements a system for the dynamic resolution of dependencies
 * that works in parallel with the BUILD system. Note that all calls
 * to goog.require will be stripped by the JSCompiler when the
 * --closure_pass option is used.
 * @see goog.provide
 * @param {string} name Namespace to include (as was given in goog.provide())
 *     in the form "goog.package.part".
 */
goog.require = function(name) {

  // if the object already exists we do not need do do anything
  // TODO(arv): If we start to support require based on file name this has
  //            to change
  // TODO(arv): If we allow goog.foo.* this has to change
  // TODO(arv): If we implement dynamic load after page load we should probably
  //            not remove this code for the compiled output
  if (!COMPILED) {
    if (goog.isProvided_(name)) {
      return;
    }

    if (goog.ENABLE_DEBUG_LOADER) {
      var path = goog.getPathFromDeps_(name);
      if (path) {
        goog.included_[path] = true;
        goog.writeScripts_();
        return;
      }
    }

    var errorMessage = 'goog.require could not find: ' + name;
    if (goog.global.console) {
      goog.global.console['error'](errorMessage);
    }


      throw Error(errorMessage);

  }
};


/**
 * Path for included scripts
 * @type {string}
 */
goog.basePath = '';


/**
 * A hook for overriding the base path.
 * @type {string|undefined}
 */
goog.global.CLOSURE_BASE_PATH;


/**
 * Whether to write out Closure's deps file. By default,
 * the deps are written.
 * @type {boolean|undefined}
 */
goog.global.CLOSURE_NO_DEPS;


/**
 * A function to import a single script. This is meant to be overridden when
 * Closure is being run in non-HTML contexts, such as web workers. It's defined
 * in the global scope so that it can be set before base.js is loaded, which
 * allows deps.js to be imported properly.
 *
 * The function is passed the script source, which is a relative URI. It should
 * return true if the script was imported, false otherwise.
 */
goog.global.CLOSURE_IMPORT_SCRIPT;


/**
 * Null function used for default values of callbacks, etc.
 * @return {void} Nothing.
 */
goog.nullFunction = function() {};


/**
 * The identity function. Returns its first argument.
 *
 * @param {*=} opt_returnValue The single value that will be returned.
 * @param {...*} var_args Optional trailing arguments. These are ignored.
 * @return {?} The first argument. We can't know the type -- just pass it along
 *      without type.
 * @deprecated Use goog.functions.identity instead.
 */
goog.identityFunction = function(opt_returnValue, var_args) {
  return opt_returnValue;
};


/**
 * When defining a class Foo with an abstract method bar(), you can do:
 *
 * Foo.prototype.bar = goog.abstractMethod
 *
 * Now if a subclass of Foo fails to override bar(), an error
 * will be thrown when bar() is invoked.
 *
 * Note: This does not take the name of the function to override as
 * an argument because that would make it more difficult to obfuscate
 * our JavaScript code.
 *
 * @type {!Function}
 * @throws {Error} when invoked to indicate the method should be
 *   overridden.
 */
goog.abstractMethod = function() {
  throw Error('unimplemented abstract method');
};


/**
 * Adds a {@code getInstance} static method that always return the same instance
 * object.
 * @param {!Function} ctor The constructor for the class to add the static
 *     method to.
 */
goog.addSingletonGetter = function(ctor) {
  ctor.getInstance = function() {
    if (ctor.instance_) {
      return ctor.instance_;
    }
    if (goog.DEBUG) {
      // NOTE: JSCompiler can't optimize away Array#push.
      goog.instantiatedSingletons_[goog.instantiatedSingletons_.length] = ctor;
    }
    return ctor.instance_ = new ctor;
  };
};


/**
 * All singleton classes that have been instantiated, for testing. Don't read
 * it directly, use the {@code goog.testing.singleton} module. The compiler
 * removes this variable if unused.
 * @type {!Array.<!Function>}
 * @private
 */
goog.instantiatedSingletons_ = [];


if (!COMPILED && goog.ENABLE_DEBUG_LOADER) {
  /**
   * Object used to keep track of urls that have already been added. This
   * record allows the prevention of circular dependencies.
   * @type {Object}
   * @private
   */
  goog.included_ = {};


  /**
   * This object is used to keep track of dependencies and other data that is
   * used for loading scripts
   * @private
   * @type {Object}
   */
  goog.dependencies_ = {
    pathToNames: {}, // 1 to many
    nameToPath: {}, // 1 to 1
    requires: {}, // 1 to many
    // used when resolving dependencies to prevent us from
    // visiting the file twice
    visited: {},
    written: {} // used to keep track of script files we have written
  };


  /**
   * Tries to detect whether is in the context of an HTML document.
   * @return {boolean} True if it looks like HTML document.
   * @private
   */
  goog.inHtmlDocument_ = function() {
    var doc = goog.global.document;
    return typeof doc != 'undefined' &&
           'write' in doc;  // XULDocument misses write.
  };


  /**
   * Tries to detect the base path of the base.js script that bootstraps Closure
   * @private
   */
  goog.findBasePath_ = function() {
    if (goog.global.CLOSURE_BASE_PATH) {
      goog.basePath = goog.global.CLOSURE_BASE_PATH;
      return;
    } else if (!goog.inHtmlDocument_()) {
      return;
    }
    var doc = goog.global.document;
    var scripts = doc.getElementsByTagName('script');
    // Search backwards since the current script is in almost all cases the one
    // that has base.js.
    for (var i = scripts.length - 1; i >= 0; --i) {
      var src = scripts[i].src;
      var qmark = src.lastIndexOf('?');
      var l = qmark == -1 ? src.length : qmark;
      if (src.substr(l - 7, 7) == 'base.js') {
        goog.basePath = src.substr(0, l - 7);
        return;
      }
    }
  };


  /**
   * Imports a script if, and only if, that script hasn't already been imported.
   * (Must be called at execution time)
   * @param {string} src Script source.
   * @private
   */
  goog.importScript_ = function(src) {
    var importScript = goog.global.CLOSURE_IMPORT_SCRIPT ||
        goog.writeScriptTag_;
    if (!goog.dependencies_.written[src] && importScript(src)) {
      goog.dependencies_.written[src] = true;
    }
  };


  /**
   * The default implementation of the import function. Writes a script tag to
   * import the script.
   *
   * @param {string} src The script source.
   * @return {boolean} True if the script was imported, false otherwise.
   * @private
   */
  goog.writeScriptTag_ = function(src) {
    if (goog.inHtmlDocument_()) {
      var doc = goog.global.document;

      // If the user tries to require a new symbol after document load,
      // something has gone terribly wrong. Doing a document.write would
      // wipe out the page.
      if (doc.readyState == 'complete') {
        // Certain test frameworks load base.js multiple times, which tries
        // to write deps.js each time. If that happens, just fail silently.
        // These frameworks wipe the page between each load of base.js, so this
        // is OK.
        var isDeps = /\bdeps.js$/.test(src);
        if (isDeps) {
          return false;
        } else {
          throw Error('Cannot write "' + src + '" after document load');
        }
      }

      doc.write(
          '<script type="text/javascript" src="' + src + '"></' + 'script>');
      return true;
    } else {
      return false;
    }
  };


  /**
   * Resolves dependencies based on the dependencies added using addDependency
   * and calls importScript_ in the correct order.
   * @private
   */
  goog.writeScripts_ = function() {
    // the scripts we need to write this time
    var scripts = [];
    var seenScript = {};
    var deps = goog.dependencies_;

    function visitNode(path) {
      if (path in deps.written) {
        return;
      }

      // we have already visited this one. We can get here if we have cyclic
      // dependencies
      if (path in deps.visited) {
        if (!(path in seenScript)) {
          seenScript[path] = true;
          scripts.push(path);
        }
        return;
      }

      deps.visited[path] = true;

      if (path in deps.requires) {
        for (var requireName in deps.requires[path]) {
          // If the required name is defined, we assume that it was already
          // bootstrapped by other means.
          if (!goog.isProvided_(requireName)) {
            if (requireName in deps.nameToPath) {
              visitNode(deps.nameToPath[requireName]);
            } else {
              throw Error('Undefined nameToPath for ' + requireName);
            }
          }
        }
      }

      if (!(path in seenScript)) {
        seenScript[path] = true;
        scripts.push(path);
      }
    }

    for (var path in goog.included_) {
      if (!deps.written[path]) {
        visitNode(path);
      }
    }

    for (var i = 0; i < scripts.length; i++) {
      if (scripts[i]) {
        goog.importScript_(goog.basePath + scripts[i]);
      } else {
        throw Error('Undefined script input');
      }
    }
  };


  /**
   * Looks at the dependency rules and tries to determine the script file that
   * fulfills a particular rule.
   * @param {string} rule In the form goog.namespace.Class or project.script.
   * @return {?string} Url corresponding to the rule, or null.
   * @private
   */
  goog.getPathFromDeps_ = function(rule) {
    if (rule in goog.dependencies_.nameToPath) {
      return goog.dependencies_.nameToPath[rule];
    } else {
      return null;
    }
  };

  goog.findBasePath_();

  // Allow projects to manage the deps files themselves.
  if (!goog.global.CLOSURE_NO_DEPS) {
    goog.importScript_(goog.basePath + 'deps.js');
  }
}



//==============================================================================
// Language Enhancements
//==============================================================================


/**
 * This is a "fixed" version of the typeof operator.  It differs from the typeof
 * operator in such a way that null returns 'null' and arrays return 'array'.
 * @param {*} value The value to get the type of.
 * @return {string} The name of the type.
 */
goog.typeOf = function(value) {
  var s = typeof value;
  if (s == 'object') {
    if (value) {
      // Check these first, so we can avoid calling Object.prototype.toString if
      // possible.
      //
      // IE improperly marshals tyepof across execution contexts, but a
      // cross-context object will still return false for "instanceof Object".
      if (value instanceof Array) {
        return 'array';
      } else if (value instanceof Object) {
        return s;
      }

      // HACK: In order to use an Object prototype method on the arbitrary
      //   value, the compiler requires the value be cast to type Object,
      //   even though the ECMA spec explicitly allows it.
      var className = Object.prototype.toString.call(
          /** @type {Object} */ (value));
      // In Firefox 3.6, attempting to access iframe window objects' length
      // property throws an NS_ERROR_FAILURE, so we need to special-case it
      // here.
      if (className == '[object Window]') {
        return 'object';
      }

      // We cannot always use constructor == Array or instanceof Array because
      // different frames have different Array objects. In IE6, if the iframe
      // where the array was created is destroyed, the array loses its
      // prototype. Then dereferencing val.splice here throws an exception, so
      // we can't use goog.isFunction. Calling typeof directly returns 'unknown'
      // so that will work. In this case, this function will return false and
      // most array functions will still work because the array is still
      // array-like (supports length and []) even though it has lost its
      // prototype.
      // Mark Miller noticed that Object.prototype.toString
      // allows access to the unforgeable [[Class]] property.
      //  15.2.4.2 Object.prototype.toString ( )
      //  When the toString method is called, the following steps are taken:
      //      1. Get the [[Class]] property of this object.
      //      2. Compute a string value by concatenating the three strings
      //         "[object ", Result(1), and "]".
      //      3. Return Result(2).
      // and this behavior survives the destruction of the execution context.
      if ((className == '[object Array]' ||
           // In IE all non value types are wrapped as objects across window
           // boundaries (not iframe though) so we have to do object detection
           // for this edge case
           typeof value.length == 'number' &&
           typeof value.splice != 'undefined' &&
           typeof value.propertyIsEnumerable != 'undefined' &&
           !value.propertyIsEnumerable('splice')

          )) {
        return 'array';
      }
      // HACK: There is still an array case that fails.
      //     function ArrayImpostor() {}
      //     ArrayImpostor.prototype = [];
      //     var impostor = new ArrayImpostor;
      // this can be fixed by getting rid of the fast path
      // (value instanceof Array) and solely relying on
      // (value && Object.prototype.toString.vall(value) === '[object Array]')
      // but that would require many more function calls and is not warranted
      // unless closure code is receiving objects from untrusted sources.

      // IE in cross-window calls does not correctly marshal the function type
      // (it appears just as an object) so we cannot use just typeof val ==
      // 'function'. However, if the object has a call property, it is a
      // function.
      if ((className == '[object Function]' ||
          typeof value.call != 'undefined' &&
          typeof value.propertyIsEnumerable != 'undefined' &&
          !value.propertyIsEnumerable('call'))) {
        return 'function';
      }


    } else {
      return 'null';
    }

  } else if (s == 'function' && typeof value.call == 'undefined') {
    // In Safari typeof nodeList returns 'function', and on Firefox
    // typeof behaves similarly for HTML{Applet,Embed,Object}Elements
    // and RegExps.  We would like to return object for those and we can
    // detect an invalid function by making sure that the function
    // object has a call method.
    return 'object';
  }
  return s;
};


/**
 * Returns true if the specified value is not |undefined|.
 * WARNING: Do not use this to test if an object has a property. Use the in
 * operator instead.  Additionally, this function assumes that the global
 * undefined variable has not been redefined.
 * @param {*} val Variable to test.
 * @return {boolean} Whether variable is defined.
 */
goog.isDef = function(val) {
  return val !== undefined;
};


/**
 * Returns true if the specified value is |null|
 * @param {*} val Variable to test.
 * @return {boolean} Whether variable is null.
 */
goog.isNull = function(val) {
  return val === null;
};


/**
 * Returns true if the specified value is defined and not null
 * @param {*} val Variable to test.
 * @return {boolean} Whether variable is defined and not null.
 */
goog.isDefAndNotNull = function(val) {
  // Note that undefined == null.
  return val != null;
};


/**
 * Returns true if the specified value is an array
 * @param {*} val Variable to test.
 * @return {boolean} Whether variable is an array.
 */
goog.isArray = function(val) {
  return goog.typeOf(val) == 'array';
};


/**
 * Returns true if the object looks like an array. To qualify as array like
 * the value needs to be either a NodeList or an object with a Number length
 * property.
 * @param {*} val Variable to test.
 * @return {boolean} Whether variable is an array.
 */
goog.isArrayLike = function(val) {
  var type = goog.typeOf(val);
  return type == 'array' || type == 'object' && typeof val.length == 'number';
};


/**
 * Returns true if the object looks like a Date. To qualify as Date-like
 * the value needs to be an object and have a getFullYear() function.
 * @param {*} val Variable to test.
 * @return {boolean} Whether variable is a like a Date.
 */
goog.isDateLike = function(val) {
  return goog.isObject(val) && typeof val.getFullYear == 'function';
};


/**
 * Returns true if the specified value is a string
 * @param {*} val Variable to test.
 * @return {boolean} Whether variable is a string.
 */
goog.isString = function(val) {
  return typeof val == 'string';
};


/**
 * Returns true if the specified value is a boolean
 * @param {*} val Variable to test.
 * @return {boolean} Whether variable is boolean.
 */
goog.isBoolean = function(val) {
  return typeof val == 'boolean';
};


/**
 * Returns true if the specified value is a number
 * @param {*} val Variable to test.
 * @return {boolean} Whether variable is a number.
 */
goog.isNumber = function(val) {
  return typeof val == 'number';
};


/**
 * Returns true if the specified value is a function
 * @param {*} val Variable to test.
 * @return {boolean} Whether variable is a function.
 */
goog.isFunction = function(val) {
  return goog.typeOf(val) == 'function';
};


/**
 * Returns true if the specified value is an object.  This includes arrays
 * and functions.
 * @param {*} val Variable to test.
 * @return {boolean} Whether variable is an object.
 */
goog.isObject = function(val) {
  var type = typeof val;
  return type == 'object' && val != null || type == 'function';
  // return Object(val) === val also works, but is slower, especially if val is
  // not an object.
};


/**
 * Gets a unique ID for an object. This mutates the object so that further
 * calls with the same object as a parameter returns the same value. The unique
 * ID is guaranteed to be unique across the current session amongst objects that
 * are passed into {@code getUid}. There is no guarantee that the ID is unique
 * or consistent across sessions. It is unsafe to generate unique ID for
 * function prototypes.
 *
 * @param {Object} obj The object to get the unique ID for.
 * @return {number} The unique ID for the object.
 */
goog.getUid = function(obj) {
  // TODO(arv): Make the type stricter, do not accept null.

  // In Opera window.hasOwnProperty exists but always returns false so we avoid
  // using it. As a consequence the unique ID generated for BaseClass.prototype
  // and SubClass.prototype will be the same.
  return obj[goog.UID_PROPERTY_] ||
      (obj[goog.UID_PROPERTY_] = ++goog.uidCounter_);
};


/**
 * Removes the unique ID from an object. This is useful if the object was
 * previously mutated using {@code goog.getUid} in which case the mutation is
 * undone.
 * @param {Object} obj The object to remove the unique ID field from.
 */
goog.removeUid = function(obj) {
  // TODO(arv): Make the type stricter, do not accept null.

  // DOM nodes in IE are not instance of Object and throws exception
  // for delete. Instead we try to use removeAttribute
  if ('removeAttribute' in obj) {
    obj.removeAttribute(goog.UID_PROPERTY_);
  }
  /** @preserveTry */
  try {
    delete obj[goog.UID_PROPERTY_];
  } catch (ex) {
  }
};


/**
 * Name for unique ID property. Initialized in a way to help avoid collisions
 * with other closure javascript on the same page.
 * @type {string}
 * @private
 */
goog.UID_PROPERTY_ = 'closure_uid_' +
    Math.floor(Math.random() * 2147483648).toString(36);


/**
 * Counter for UID.
 * @type {number}
 * @private
 */
goog.uidCounter_ = 0;


/**
 * Adds a hash code field to an object. The hash code is unique for the
 * given object.
 * @param {Object} obj The object to get the hash code for.
 * @return {number} The hash code for the object.
 * @deprecated Use goog.getUid instead.
 */
goog.getHashCode = goog.getUid;


/**
 * Removes the hash code field from an object.
 * @param {Object} obj The object to remove the field from.
 * @deprecated Use goog.removeUid instead.
 */
goog.removeHashCode = goog.removeUid;


/**
 * Clones a value. The input may be an Object, Array, or basic type. Objects and
 * arrays will be cloned recursively.
 *
 * WARNINGS:
 * <code>goog.cloneObject</code> does not detect reference loops. Objects that
 * refer to themselves will cause infinite recursion.
 *
 * <code>goog.cloneObject</code> is unaware of unique identifiers, and copies
 * UIDs created by <code>getUid</code> into cloned results.
 *
 * @param {*} obj The value to clone.
 * @return {*} A clone of the input value.
 * @deprecated goog.cloneObject is unsafe. Prefer the goog.object methods.
 */
goog.cloneObject = function(obj) {
  var type = goog.typeOf(obj);
  if (type == 'object' || type == 'array') {
    if (obj.clone) {
      return obj.clone();
    }
    var clone = type == 'array' ? [] : {};
    for (var key in obj) {
      clone[key] = goog.cloneObject(obj[key]);
    }
    return clone;
  }

  return obj;
};


/**
 * A native implementation of goog.bind.
 * @param {Function} fn A function to partially apply.
 * @param {Object|undefined} selfObj Specifies the object which |this| should
 *     point to when the function is run.
 * @param {...*} var_args Additional arguments that are partially
 *     applied to the function.
 * @return {!Function} A partially-applied form of the function bind() was
 *     invoked as a method of.
 * @private
 * @suppress {deprecated} The compiler thinks that Function.prototype.bind
 *     is deprecated because some people have declared a pure-JS version.
 *     Only the pure-JS version is truly deprecated.
 */
goog.bindNative_ = function(fn, selfObj, var_args) {
  return /** @type {!Function} */ (fn.call.apply(fn.bind, arguments));
};


/**
 * A pure-JS implementation of goog.bind.
 * @param {Function} fn A function to partially apply.
 * @param {Object|undefined} selfObj Specifies the object which |this| should
 *     point to when the function is run.
 * @param {...*} var_args Additional arguments that are partially
 *     applied to the function.
 * @return {!Function} A partially-applied form of the function bind() was
 *     invoked as a method of.
 * @private
 */
goog.bindJs_ = function(fn, selfObj, var_args) {
  if (!fn) {
    throw new Error();
  }

  if (arguments.length > 2) {
    var boundArgs = Array.prototype.slice.call(arguments, 2);
    return function() {
      // Prepend the bound arguments to the current arguments.
      var newArgs = Array.prototype.slice.call(arguments);
      Array.prototype.unshift.apply(newArgs, boundArgs);
      return fn.apply(selfObj, newArgs);
    };

  } else {
    return function() {
      return fn.apply(selfObj, arguments);
    };
  }
};


/**
 * Partially applies this function to a particular 'this object' and zero or
 * more arguments. The result is a new function with some arguments of the first
 * function pre-filled and the value of |this| 'pre-specified'.<br><br>
 *
 * Remaining arguments specified at call-time are appended to the pre-
 * specified ones.<br><br>
 *
 * Also see: {@link #partial}.<br><br>
 *
 * Usage:
 * <pre>var barMethBound = bind(myFunction, myObj, 'arg1', 'arg2');
 * barMethBound('arg3', 'arg4');</pre>
 *
 * @param {Function} fn A function to partially apply.
 * @param {Object|undefined} selfObj Specifies the object which |this| should
 *     point to when the function is run.
 * @param {...*} var_args Additional arguments that are partially
 *     applied to the function.
 * @return {!Function} A partially-applied form of the function bind() was
 *     invoked as a method of.
 * @suppress {deprecated} See above.
 */
goog.bind = function(fn, selfObj, var_args) {
  // TODO(nicksantos): narrow the type signature.
  if (Function.prototype.bind &&
      // NOTE(nicksantos): Somebody pulled base.js into the default
      // Chrome extension environment. This means that for Chrome extensions,
      // they get the implementation of Function.prototype.bind that
      // calls goog.bind instead of the native one. Even worse, we don't want
      // to introduce a circular dependency between goog.bind and
      // Function.prototype.bind, so we have to hack this to make sure it
      // works correctly.
      Function.prototype.bind.toString().indexOf('native code') != -1) {
    goog.bind = goog.bindNative_;
  } else {
    goog.bind = goog.bindJs_;
  }
  return goog.bind.apply(null, arguments);
};


/**
 * Like bind(), except that a 'this object' is not required. Useful when the
 * target function is already bound.
 *
 * Usage:
 * var g = partial(f, arg1, arg2);
 * g(arg3, arg4);
 *
 * @param {Function} fn A function to partially apply.
 * @param {...*} var_args Additional arguments that are partially
 *     applied to fn.
 * @return {!Function} A partially-applied form of the function bind() was
 *     invoked as a method of.
 */
goog.partial = function(fn, var_args) {
  var args = Array.prototype.slice.call(arguments, 1);
  return function() {
    // Prepend the bound arguments to the current arguments.
    var newArgs = Array.prototype.slice.call(arguments);
    newArgs.unshift.apply(newArgs, args);
    return fn.apply(this, newArgs);
  };
};


/**
 * Copies all the members of a source object to a target object. This method
 * does not work on all browsers for all objects that contain keys such as
 * toString or hasOwnProperty. Use goog.object.extend for this purpose.
 * @param {Object} target Target.
 * @param {Object} source Source.
 */
goog.mixin = function(target, source) {
  for (var x in source) {
    target[x] = source[x];
  }

  // For IE7 or lower, the for-in-loop does not contain any properties that are
  // not enumerable on the prototype object (for example, isPrototypeOf from
  // Object.prototype) but also it will not include 'replace' on objects that
  // extend String and change 'replace' (not that it is common for anyone to
  // extend anything except Object).
};


/**
 * @return {number} An integer value representing the number of milliseconds
 *     between midnight, January 1, 1970 and the current time.
 */
goog.now = Date.now || (function() {
  // Unary plus operator converts its operand to a number which in the case of
  // a date is done by calling getTime().
  return +new Date();
});


/**
 * Evals javascript in the global scope.  In IE this uses execScript, other
 * browsers use goog.global.eval. If goog.global.eval does not evaluate in the
 * global scope (for example, in Safari), appends a script tag instead.
 * Throws an exception if neither execScript or eval is defined.
 * @param {string} script JavaScript string.
 */
goog.globalEval = function(script) {
  if (goog.global.execScript) {
    goog.global.execScript(script, 'JavaScript');
  } else if (goog.global.eval) {
    // Test to see if eval works
    if (goog.evalWorksForGlobals_ == null) {
      goog.global.eval('var _et_ = 1;');
      if (typeof goog.global['_et_'] != 'undefined') {
        delete goog.global['_et_'];
        goog.evalWorksForGlobals_ = true;
      } else {
        goog.evalWorksForGlobals_ = false;
      }
    }

    if (goog.evalWorksForGlobals_) {
      goog.global.eval(script);
    } else {
      var doc = goog.global.document;
      var scriptElt = doc.createElement('script');
      scriptElt.type = 'text/javascript';
      scriptElt.defer = false;
      // Note(user): can't use .innerHTML since "t('<test>')" will fail and
      // .text doesn't work in Safari 2.  Therefore we append a text node.
      scriptElt.appendChild(doc.createTextNode(script));
      doc.body.appendChild(scriptElt);
      doc.body.removeChild(scriptElt);
    }
  } else {
    throw Error('goog.globalEval not available');
  }
};


/**
 * Indicates whether or not we can call 'eval' directly to eval code in the
 * global scope. Set to a Boolean by the first call to goog.globalEval (which
 * empirically tests whether eval works for globals). @see goog.globalEval
 * @type {?boolean}
 * @private
 */
goog.evalWorksForGlobals_ = null;


/**
 * Optional map of CSS class names to obfuscated names used with
 * goog.getCssName().
 * @type {Object|undefined}
 * @private
 * @see goog.setCssNameMapping
 */
goog.cssNameMapping_;


/**
 * Optional obfuscation style for CSS class names. Should be set to either
 * 'BY_WHOLE' or 'BY_PART' if defined.
 * @type {string|undefined}
 * @private
 * @see goog.setCssNameMapping
 */
goog.cssNameMappingStyle_;


/**
 * Handles strings that are intended to be used as CSS class names.
 *
 * This function works in tandem with @see goog.setCssNameMapping.
 *
 * Without any mapping set, the arguments are simple joined with a
 * hyphen and passed through unaltered.
 *
 * When there is a mapping, there are two possible styles in which
 * these mappings are used. In the BY_PART style, each part (i.e. in
 * between hyphens) of the passed in css name is rewritten according
 * to the map. In the BY_WHOLE style, the full css name is looked up in
 * the map directly. If a rewrite is not specified by the map, the
 * compiler will output a warning.
 *
 * When the mapping is passed to the compiler, it will replace calls
 * to goog.getCssName with the strings from the mapping, e.g.
 *     var x = goog.getCssName('foo');
 *     var y = goog.getCssName(this.baseClass, 'active');
 *  becomes:
 *     var x= 'foo';
 *     var y = this.baseClass + '-active';
 *
 * If one argument is passed it will be processed, if two are passed
 * only the modifier will be processed, as it is assumed the first
 * argument was generated as a result of calling goog.getCssName.
 *
 * @param {string} className The class name.
 * @param {string=} opt_modifier A modifier to be appended to the class name.
 * @return {string} The class name or the concatenation of the class name and
 *     the modifier.
 */
goog.getCssName = function(className, opt_modifier) {
  var getMapping = function(cssName) {
    return goog.cssNameMapping_[cssName] || cssName;
  };

  var renameByParts = function(cssName) {
    // Remap all the parts individually.
    var parts = cssName.split('-');
    var mapped = [];
    for (var i = 0; i < parts.length; i++) {
      mapped.push(getMapping(parts[i]));
    }
    return mapped.join('-');
  };

  var rename;
  if (goog.cssNameMapping_) {
    rename = goog.cssNameMappingStyle_ == 'BY_WHOLE' ?
        getMapping : renameByParts;
  } else {
    rename = function(a) {
      return a;
    };
  }

  if (opt_modifier) {
    return className + '-' + rename(opt_modifier);
  } else {
    return rename(className);
  }
};


/**
 * Sets the map to check when returning a value from goog.getCssName(). Example:
 * <pre>
 * goog.setCssNameMapping({
 *   "goog": "a",
 *   "disabled": "b",
 * });
 *
 * var x = goog.getCssName('goog');
 * // The following evaluates to: "a a-b".
 * goog.getCssName('goog') + ' ' + goog.getCssName(x, 'disabled')
 * </pre>
 * When declared as a map of string literals to string literals, the JSCompiler
 * will replace all calls to goog.getCssName() using the supplied map if the
 * --closure_pass flag is set.
 *
 * @param {!Object} mapping A map of strings to strings where keys are possible
 *     arguments to goog.getCssName() and values are the corresponding values
 *     that should be returned.
 * @param {string=} opt_style The style of css name mapping. There are two valid
 *     options: 'BY_PART', and 'BY_WHOLE'.
 * @see goog.getCssName for a description.
 */
goog.setCssNameMapping = function(mapping, opt_style) {
  goog.cssNameMapping_ = mapping;
  goog.cssNameMappingStyle_ = opt_style;
};


/**
 * To use CSS renaming in compiled mode, one of the input files should have a
 * call to goog.setCssNameMapping() with an object literal that the JSCompiler
 * can extract and use to replace all calls to goog.getCssName(). In uncompiled
 * mode, JavaScript code should be loaded before this base.js file that declares
 * a global variable, CLOSURE_CSS_NAME_MAPPING, which is used below. This is
 * to ensure that the mapping is loaded before any calls to goog.getCssName()
 * are made in uncompiled mode.
 *
 * A hook for overriding the CSS name mapping.
 * @type {Object|undefined}
 */
goog.global.CLOSURE_CSS_NAME_MAPPING;


if (!COMPILED && goog.global.CLOSURE_CSS_NAME_MAPPING) {
  // This does not call goog.setCssNameMapping() because the JSCompiler
  // requires that goog.setCssNameMapping() be called with an object literal.
  goog.cssNameMapping_ = goog.global.CLOSURE_CSS_NAME_MAPPING;
}


/**
 * Gets a localized message.
 *
 * This function is a compiler primitive. If you give the compiler a localized
 * message bundle, it will replace the string at compile-time with a localized
 * version, and expand goog.getMsg call to a concatenated string.
 *
 * Messages must be initialized in the form:
 * <code>
 * var MSG_NAME = goog.getMsg('Hello {$placeholder}', {'placeholder': 'world'});
 * </code>
 *
 * @param {string} str Translatable string, places holders in the form {$foo}.
 * @param {Object=} opt_values Map of place holder name to value.
 * @return {string} message with placeholders filled.
 */
goog.getMsg = function(str, opt_values) {
  var values = opt_values || {};
  for (var key in values) {
    var value = ('' + values[key]).replace(/\$/g, '$$$$');
    str = str.replace(new RegExp('\\{\\$' + key + '\\}', 'gi'), value);
  }
  return str;
};


/**
 * Gets a localized message. If the message does not have a translation, gives a
 * fallback message.
 *
 * This is useful when introducing a new message that has not yet been
 * translated into all languages.
 *
 * This function is a compiler primtive. Must be used in the form:
 * <code>var x = goog.getMsgWithFallback(MSG_A, MSG_B);</code>
 * where MSG_A and MSG_B were initialized with goog.getMsg.
 *
 * @param {string} a The preferred message.
 * @param {string} b The fallback message.
 * @return {string} The best translated message.
 */
goog.getMsgWithFallback = function(a, b) {
  return a;
};


/**
 * Exposes an unobfuscated global namespace path for the given object.
 * Note that fields of the exported object *will* be obfuscated,
 * unless they are exported in turn via this function or
 * goog.exportProperty
 *
 * <p>Also handy for making public items that are defined in anonymous
 * closures.
 *
 * ex. goog.exportSymbol('public.path.Foo', Foo);
 *
 * ex. goog.exportSymbol('public.path.Foo.staticFunction',
 *                       Foo.staticFunction);
 *     public.path.Foo.staticFunction();
 *
 * ex. goog.exportSymbol('public.path.Foo.prototype.myMethod',
 *                       Foo.prototype.myMethod);
 *     new public.path.Foo().myMethod();
 *
 * @param {string} publicPath Unobfuscated name to export.
 * @param {*} object Object the name should point to.
 * @param {Object=} opt_objectToExportTo The object to add the path to; default
 *     is |goog.global|.
 */
goog.exportSymbol = function(publicPath, object, opt_objectToExportTo) {
  goog.exportPath_(publicPath, object, opt_objectToExportTo);
};


/**
 * Exports a property unobfuscated into the object's namespace.
 * ex. goog.exportProperty(Foo, 'staticFunction', Foo.staticFunction);
 * ex. goog.exportProperty(Foo.prototype, 'myMethod', Foo.prototype.myMethod);
 * @param {Object} object Object whose static property is being exported.
 * @param {string} publicName Unobfuscated name to export.
 * @param {*} symbol Object the name should point to.
 */
goog.exportProperty = function(object, publicName, symbol) {
  object[publicName] = symbol;
};


/**
 * Inherit the prototype methods from one constructor into another.
 *
 * Usage:
 * <pre>
 * function ParentClass(a, b) { }
 * ParentClass.prototype.foo = function(a) { }
 *
 * function ChildClass(a, b, c) {
 *   goog.base(this, a, b);
 * }
 * goog.inherits(ChildClass, ParentClass);
 *
 * var child = new ChildClass('a', 'b', 'see');
 * child.foo(); // works
 * </pre>
 *
 * In addition, a superclass' implementation of a method can be invoked
 * as follows:
 *
 * <pre>
 * ChildClass.prototype.foo = function(a) {
 *   ChildClass.superClass_.foo.call(this, a);
 *   // other code
 * };
 * </pre>
 *
 * @param {Function} childCtor Child class.
 * @param {Function} parentCtor Parent class.
 */
goog.inherits = function(childCtor, parentCtor) {
  /** @constructor */
  function tempCtor() {};
  tempCtor.prototype = parentCtor.prototype;
  childCtor.superClass_ = parentCtor.prototype;
  childCtor.prototype = new tempCtor();
  /** @override */
  childCtor.prototype.constructor = childCtor;
};


/**
 * Call up to the superclass.
 *
 * If this is called from a constructor, then this calls the superclass
 * contructor with arguments 1-N.
 *
 * If this is called from a prototype method, then you must pass
 * the name of the method as the second argument to this function. If
 * you do not, you will get a runtime error. This calls the superclass'
 * method with arguments 2-N.
 *
 * This function only works if you use goog.inherits to express
 * inheritance relationships between your classes.
 *
 * This function is a compiler primitive. At compile-time, the
 * compiler will do macro expansion to remove a lot of
 * the extra overhead that this function introduces. The compiler
 * will also enforce a lot of the assumptions that this function
 * makes, and treat it as a compiler error if you break them.
 *
 * @param {!Object} me Should always be "this".
 * @param {*=} opt_methodName The method name if calling a super method.
 * @param {...*} var_args The rest of the arguments.
 * @return {*} The return value of the superclass method.
 */
goog.base = function(me, opt_methodName, var_args) {
  var caller = arguments.callee.caller;
  if (caller.superClass_) {
    // This is a constructor. Call the superclass constructor.
    return caller.superClass_.constructor.apply(
        me, Array.prototype.slice.call(arguments, 1));
  }

  var args = Array.prototype.slice.call(arguments, 2);
  var foundCaller = false;
  for (var ctor = me.constructor;
       ctor; ctor = ctor.superClass_ && ctor.superClass_.constructor) {
    if (ctor.prototype[opt_methodName] === caller) {
      foundCaller = true;
    } else if (foundCaller) {
      return ctor.prototype[opt_methodName].apply(me, args);
    }
  }

  // If we did not find the caller in the prototype chain,
  // then one of two things happened:
  // 1) The caller is an instance method.
  // 2) This method was not called by the right caller.
  if (me[opt_methodName] === caller) {
    return me.constructor.prototype[opt_methodName].apply(me, args);
  } else {
    throw Error(
        'goog.base called from a method of one name ' +
        'to a method of a different name');
  }
};


/**
 * Allow for aliasing within scope functions.  This function exists for
 * uncompiled code - in compiled code the calls will be inlined and the
 * aliases applied.  In uncompiled code the function is simply run since the
 * aliases as written are valid JavaScript.
 * @param {function()} fn Function to call.  This function can contain aliases
 *     to namespaces (e.g. "var dom = goog.dom") or classes
 *    (e.g. "var Timer = goog.Timer").
 */
goog.scope = function(fn) {
  fn.call(goog.global);
};



// Copyright 2006 The Closure Library Authors. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS-IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * @fileoverview Utilities for string manipulation.
 */


/**
 * Namespace for string utilities
 */
goog.provide('goog.string');
goog.provide('goog.string.Unicode');


/**
 * Common Unicode string characters.
 * @enum {string}
 */
goog.string.Unicode = {
  NBSP: '\xa0'
};


/**
 * Fast prefix-checker.
 * @param {string} str The string to check.
 * @param {string} prefix A string to look for at the start of {@code str}.
 * @return {boolean} True if {@code str} begins with {@code prefix}.
 */
goog.string.startsWith = function(str, prefix) {
  return str.lastIndexOf(prefix, 0) == 0;
};


/**
 * Fast suffix-checker.
 * @param {string} str The string to check.
 * @param {string} suffix A string to look for at the end of {@code str}.
 * @return {boolean} True if {@code str} ends with {@code suffix}.
 */
goog.string.endsWith = function(str, suffix) {
  var l = str.length - suffix.length;
  return l >= 0 && str.indexOf(suffix, l) == l;
};


/**
 * Case-insensitive prefix-checker.
 * @param {string} str The string to check.
 * @param {string} prefix  A string to look for at the end of {@code str}.
 * @return {boolean} True if {@code str} begins with {@code prefix} (ignoring
 *     case).
 */
goog.string.caseInsensitiveStartsWith = function(str, prefix) {
  return goog.string.caseInsensitiveCompare(
      prefix, str.substr(0, prefix.length)) == 0;
};


/**
 * Case-insensitive suffix-checker.
 * @param {string} str The string to check.
 * @param {string} suffix A string to look for at the end of {@code str}.
 * @return {boolean} True if {@code str} ends with {@code suffix} (ignoring
 *     case).
 */
goog.string.caseInsensitiveEndsWith = function(str, suffix) {
  return goog.string.caseInsensitiveCompare(
      suffix, str.substr(str.length - suffix.length, suffix.length)) == 0;
};


/**
 * Does simple python-style string substitution.
 * subs("foo%s hot%s", "bar", "dog") becomes "foobar hotdog".
 * @param {string} str The string containing the pattern.
 * @param {...*} var_args The items to substitute into the pattern.
 * @return {string} A copy of {@code str} in which each occurrence of
 *     {@code %s} has been replaced an argument from {@code var_args}.
 */
goog.string.subs = function(str, var_args) {
  // This appears to be slow, but testing shows it compares more or less
  // equivalent to the regex.exec method.
  for (var i = 1; i < arguments.length; i++) {
    // We cast to String in case an argument is a Function.  Replacing $&, for
    // example, with $$$& stops the replace from subsituting the whole match
    // into the resultant string.  $$$& in the first replace becomes $$& in the
    //  second, which leaves $& in the resultant string.  Also:
    // $$, $`, $', $n $nn
    var replacement = String(arguments[i]).replace(/\$/g, '$$$$');
    str = str.replace(/\%s/, replacement);
  }
  return str;
};


/**
 * Converts multiple whitespace chars (spaces, non-breaking-spaces, new lines
 * and tabs) to a single space, and strips leading and trailing whitespace.
 * @param {string} str Input string.
 * @return {string} A copy of {@code str} with collapsed whitespace.
 */
goog.string.collapseWhitespace = function(str) {
  // Since IE doesn't include non-breaking-space (0xa0) in their \s character
  // class (as required by section 7.2 of the ECMAScript spec), we explicitly
  // include it in the regexp to enforce consistent cross-browser behavior.
  return str.replace(/[\s\xa0]+/g, ' ').replace(/^\s+|\s+$/g, '');
};


/**
 * Checks if a string is empty or contains only whitespaces.
 * @param {string} str The string to check.
 * @return {boolean} True if {@code str} is empty or whitespace only.
 */
goog.string.isEmpty = function(str) {
  // testing length == 0 first is actually slower in all browsers (about the
  // same in Opera).
  // Since IE doesn't include non-breaking-space (0xa0) in their \s character
  // class (as required by section 7.2 of the ECMAScript spec), we explicitly
  // include it in the regexp to enforce consistent cross-browser behavior.
  return /^[\s\xa0]*$/.test(str);
};


/**
 * Checks if a string is null, undefined, empty or contains only whitespaces.
 * @param {*} str The string to check.
 * @return {boolean} True if{@code str} is null, undefined, empty, or
 *     whitespace only.
 */
goog.string.isEmptySafe = function(str) {
  return goog.string.isEmpty(goog.string.makeSafe(str));
};


/**
 * Checks if a string is all breaking whitespace.
 * @param {string} str The string to check.
 * @return {boolean} Whether the string is all breaking whitespace.
 */
goog.string.isBreakingWhitespace = function(str) {
  return !/[^\t\n\r ]/.test(str);
};


/**
 * Checks if a string contains all letters.
 * @param {string} str string to check.
 * @return {boolean} True if {@code str} consists entirely of letters.
 */
goog.string.isAlpha = function(str) {
  return !/[^a-zA-Z]/.test(str);
};


/**
 * Checks if a string contains only numbers.
 * @param {*} str string to check. If not a string, it will be
 *     casted to one.
 * @return {boolean} True if {@code str} is numeric.
 */
goog.string.isNumeric = function(str) {
  return !/[^0-9]/.test(str);
};


/**
 * Checks if a string contains only numbers or letters.
 * @param {string} str string to check.
 * @return {boolean} True if {@code str} is alphanumeric.
 */
goog.string.isAlphaNumeric = function(str) {
  return !/[^a-zA-Z0-9]/.test(str);
};


/**
 * Checks if a character is a space character.
 * @param {string} ch Character to check.
 * @return {boolean} True if {code ch} is a space.
 */
goog.string.isSpace = function(ch) {
  return ch == ' ';
};


/**
 * Checks if a character is a valid unicode character.
 * @param {string} ch Character to check.
 * @return {boolean} True if {code ch} is a valid unicode character.
 */
goog.string.isUnicodeChar = function(ch) {
  return ch.length == 1 && ch >= ' ' && ch <= '~' ||
         ch >= '\u0080' && ch <= '\uFFFD';
};


/**
 * Takes a string and replaces newlines with a space. Multiple lines are
 * replaced with a single space.
 * @param {string} str The string from which to strip newlines.
 * @return {string} A copy of {@code str} stripped of newlines.
 */
goog.string.stripNewlines = function(str) {
  return str.replace(/(\r\n|\r|\n)+/g, ' ');
};


/**
 * Replaces Windows and Mac new lines with unix style: \r or \r\n with \n.
 * @param {string} str The string to in which to canonicalize newlines.
 * @return {string} {@code str} A copy of {@code} with canonicalized newlines.
 */
goog.string.canonicalizeNewlines = function(str) {
  return str.replace(/(\r\n|\r|\n)/g, '\n');
};


/**
 * Normalizes whitespace in a string, replacing all whitespace chars with
 * a space.
 * @param {string} str The string in which to normalize whitespace.
 * @return {string} A copy of {@code str} with all whitespace normalized.
 */
goog.string.normalizeWhitespace = function(str) {
  return str.replace(/\xa0|\s/g, ' ');
};


/**
 * Normalizes spaces in a string, replacing all consecutive spaces and tabs
 * with a single space. Replaces non-breaking space with a space.
 * @param {string} str The string in which to normalize spaces.
 * @return {string} A copy of {@code str} with all consecutive spaces and tabs
 *    replaced with a single space.
 */
goog.string.normalizeSpaces = function(str) {
  return str.replace(/\xa0|[ \t]+/g, ' ');
};


/**
 * Removes the breaking spaces from the left and right of the string and
 * collapses the sequences of breaking spaces in the middle into single spaces.
 * The original and the result strings render the same way in HTML.
 * @param {string} str A string in which to collapse spaces.
 * @return {string} Copy of the string with normalized breaking spaces.
 */
goog.string.collapseBreakingSpaces = function(str) {
  return str.replace(/[\t\r\n ]+/g, ' ').replace(
      /^[\t\r\n ]+|[\t\r\n ]+$/g, '');
};


/**
 * Trims white spaces to the left and right of a string.
 * @param {string} str The string to trim.
 * @return {string} A trimmed copy of {@code str}.
 */
goog.string.trim = function(str) {
  // Since IE doesn't include non-breaking-space (0xa0) in their \s character
  // class (as required by section 7.2 of the ECMAScript spec), we explicitly
  // include it in the regexp to enforce consistent cross-browser behavior.
  return str.replace(/^[\s\xa0]+|[\s\xa0]+$/g, '');
};


/**
 * Trims whitespaces at the left end of a string.
 * @param {string} str The string to left trim.
 * @return {string} A trimmed copy of {@code str}.
 */
goog.string.trimLeft = function(str) {
  // Since IE doesn't include non-breaking-space (0xa0) in their \s character
  // class (as required by section 7.2 of the ECMAScript spec), we explicitly
  // include it in the regexp to enforce consistent cross-browser behavior.
  return str.replace(/^[\s\xa0]+/, '');
};


/**
 * Trims whitespaces at the right end of a string.
 * @param {string} str The string to right trim.
 * @return {string} A trimmed copy of {@code str}.
 */
goog.string.trimRight = function(str) {
  // Since IE doesn't include non-breaking-space (0xa0) in their \s character
  // class (as required by section 7.2 of the ECMAScript spec), we explicitly
  // include it in the regexp to enforce consistent cross-browser behavior.
  return str.replace(/[\s\xa0]+$/, '');
};


/**
 * A string comparator that ignores case.
 * -1 = str1 less than str2
 *  0 = str1 equals str2
 *  1 = str1 greater than str2
 *
 * @param {string} str1 The string to compare.
 * @param {string} str2 The string to compare {@code str1} to.
 * @return {number} The comparator result, as described above.
 */
goog.string.caseInsensitiveCompare = function(str1, str2) {
  var test1 = String(str1).toLowerCase();
  var test2 = String(str2).toLowerCase();

  if (test1 < test2) {
    return -1;
  } else if (test1 == test2) {
    return 0;
  } else {
    return 1;
  }
};


/**
 * Regular expression used for splitting a string into substrings of fractional
 * numbers, integers, and non-numeric characters.
 * @type {RegExp}
 * @private
 */
goog.string.numerateCompareRegExp_ = /(\.\d+)|(\d+)|(\D+)/g;


/**
 * String comparison function that handles numbers in a way humans might expect.
 * Using this function, the string "File 2.jpg" sorts before "File 10.jpg". The
 * comparison is mostly case-insensitive, though strings that are identical
 * except for case are sorted with the upper-case strings before lower-case.
 *
 * This comparison function is significantly slower (about 500x) than either
 * the default or the case-insensitive compare. It should not be used in
 * time-critical code, but should be fast enough to sort several hundred short
 * strings (like filenames) with a reasonable delay.
 *
 * @param {string} str1 The string to compare in a numerically sensitive way.
 * @param {string} str2 The string to compare {@code str1} to.
 * @return {number} less than 0 if str1 < str2, 0 if str1 == str2, greater than
 *     0 if str1 > str2.
 */
goog.string.numerateCompare = function(str1, str2) {
  if (str1 == str2) {
    return 0;
  }
  if (!str1) {
    return -1;
  }
  if (!str2) {
    return 1;
  }

  // Using match to split the entire string ahead of time turns out to be faster
  // for most inputs than using RegExp.exec or iterating over each character.
  var tokens1 = str1.toLowerCase().match(goog.string.numerateCompareRegExp_);
  var tokens2 = str2.toLowerCase().match(goog.string.numerateCompareRegExp_);

  var count = Math.min(tokens1.length, tokens2.length);

  for (var i = 0; i < count; i++) {
    var a = tokens1[i];
    var b = tokens2[i];

    // Compare pairs of tokens, returning if one token sorts before the other.
    if (a != b) {

      // Only if both tokens are integers is a special comparison required.
      // Decimal numbers are sorted as strings (e.g., '.09' < '.1').
      var num1 = parseInt(a, 10);
      if (!isNaN(num1)) {
        var num2 = parseInt(b, 10);
        if (!isNaN(num2) && num1 - num2) {
          return num1 - num2;
        }
      }
      return a < b ? -1 : 1;
    }
  }

  // If one string is a substring of the other, the shorter string sorts first.
  if (tokens1.length != tokens2.length) {
    return tokens1.length - tokens2.length;
  }

  // The two strings must be equivalent except for case (perfect equality is
  // tested at the head of the function.) Revert to default ASCII-betical string
  // comparison to stablize the sort.
  return str1 < str2 ? -1 : 1;
};


/**
 * URL-encodes a string
 * @param {*} str The string to url-encode.
 * @return {string} An encoded copy of {@code str} that is safe for urls.
 *     Note that '#', ':', and other characters used to delimit portions
 *     of URLs *will* be encoded.
 */
goog.string.urlEncode = function(str) {
  return encodeURIComponent(String(str));
};


/**
 * URL-decodes the string. We need to specially handle '+'s because
 * the javascript library doesn't convert them to spaces.
 * @param {string} str The string to url decode.
 * @return {string} The decoded {@code str}.
 */
goog.string.urlDecode = function(str) {
  return decodeURIComponent(str.replace(/\+/g, ' '));
};


/**
 * Converts \n to <br>s or <br />s.
 * @param {string} str The string in which to convert newlines.
 * @param {boolean=} opt_xml Whether to use XML compatible tags.
 * @return {string} A copy of {@code str} with converted newlines.
 */
goog.string.newLineToBr = function(str, opt_xml) {
  return str.replace(/(\r\n|\r|\n)/g, opt_xml ? '<br />' : '<br>');
};


/**
 * Escape double quote '"' characters in addition to '&', '<', and '>' so that a
 * string can be included in an HTML tag attribute value within double quotes.
 *
 * It should be noted that > doesn't need to be escaped for the HTML or XML to
 * be valid, but it has been decided to escape it for consistency with other
 * implementations.
 *
 * NOTE(user):
 * HtmlEscape is often called during the generation of large blocks of HTML.
 * Using statics for the regular expressions and strings is an optimization
 * that can more than half the amount of time IE spends in this function for
 * large apps, since strings and regexes both contribute to GC allocations.
 *
 * Testing for the presence of a character before escaping increases the number
 * of function calls, but actually provides a speed increase for the average
 * case -- since the average case often doesn't require the escaping of all 4
 * characters and indexOf() is much cheaper than replace().
 * The worst case does suffer slightly from the additional calls, therefore the
 * opt_isLikelyToContainHtmlChars option has been included for situations
 * where all 4 HTML entities are very likely to be present and need escaping.
 *
 * Some benchmarks (times tended to fluctuate +-0.05ms):
 *                                     FireFox                     IE6
 * (no chars / average (mix of cases) / all 4 chars)
 * no checks                     0.13 / 0.22 / 0.22         0.23 / 0.53 / 0.80
 * indexOf                       0.08 / 0.17 / 0.26         0.22 / 0.54 / 0.84
 * indexOf + re test             0.07 / 0.17 / 0.28         0.19 / 0.50 / 0.85
 *
 * An additional advantage of checking if replace actually needs to be called
 * is a reduction in the number of object allocations, so as the size of the
 * application grows the difference between the various methods would increase.
 *
 * @param {string} str string to be escaped.
 * @param {boolean=} opt_isLikelyToContainHtmlChars Don't perform a check to see
 *     if the character needs replacing - use this option if you expect each of
 *     the characters to appear often. Leave false if you expect few html
 *     characters to occur in your strings, such as if you are escaping HTML.
 * @return {string} An escaped copy of {@code str}.
 */
goog.string.htmlEscape = function(str, opt_isLikelyToContainHtmlChars) {

  if (opt_isLikelyToContainHtmlChars) {
    return str.replace(goog.string.amperRe_, '&amp;')
          .replace(goog.string.ltRe_, '&lt;')
          .replace(goog.string.gtRe_, '&gt;')
          .replace(goog.string.quotRe_, '&quot;');

  } else {
    // quick test helps in the case when there are no chars to replace, in
    // worst case this makes barely a difference to the time taken
    if (!goog.string.allRe_.test(str)) return str;

    // str.indexOf is faster than regex.test in this case
    if (str.indexOf('&') != -1) {
      str = str.replace(goog.string.amperRe_, '&amp;');
    }
    if (str.indexOf('<') != -1) {
      str = str.replace(goog.string.ltRe_, '&lt;');
    }
    if (str.indexOf('>') != -1) {
      str = str.replace(goog.string.gtRe_, '&gt;');
    }
    if (str.indexOf('"') != -1) {
      str = str.replace(goog.string.quotRe_, '&quot;');
    }
    return str;
  }
};


/**
 * Regular expression that matches an ampersand, for use in escaping.
 * @type {RegExp}
 * @private
 */
goog.string.amperRe_ = /&/g;


/**
 * Regular expression that matches a less than sign, for use in escaping.
 * @type {RegExp}
 * @private
 */
goog.string.ltRe_ = /</g;


/**
 * Regular expression that matches a greater than sign, for use in escaping.
 * @type {RegExp}
 * @private
 */
goog.string.gtRe_ = />/g;


/**
 * Regular expression that matches a double quote, for use in escaping.
 * @type {RegExp}
 * @private
 */
goog.string.quotRe_ = /\"/g;


/**
 * Regular expression that matches any character that needs to be escaped.
 * @type {RegExp}
 * @private
 */
goog.string.allRe_ = /[&<>\"]/;


/**
 * Unescapes an HTML string.
 *
 * @param {string} str The string to unescape.
 * @return {string} An unescaped copy of {@code str}.
 */
goog.string.unescapeEntities = function(str) {
  if (goog.string.contains(str, '&')) {
    // We are careful not to use a DOM if we do not have one. We use the []
    // notation so that the JSCompiler will not complain about these objects and
    // fields in the case where we have no DOM.
    if ('document' in goog.global) {
      return goog.string.unescapeEntitiesUsingDom_(str);
    } else {
      // Fall back on pure XML entities
      return goog.string.unescapePureXmlEntities_(str);
    }
  }
  return str;
};


/**
 * Unescapes an HTML string using a DOM to resolve non-XML, non-numeric
 * entities. This function is XSS-safe and whitespace-preserving.
 * @private
 * @param {string} str The string to unescape.
 * @return {string} The unescaped {@code str} string.
 */
goog.string.unescapeEntitiesUsingDom_ = function(str) {
  var seen = {'&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"'};
  var div = document.createElement('div');
  // Match as many valid entity characters as possible. If the actual entity
  // happens to be shorter, it will still work as innerHTML will return the
  // trailing characters unchanged. Since the entity characters do not include
  // open angle bracket, there is no chance of XSS from the innerHTML use.
  // Since no whitespace is passed to innerHTML, whitespace is preserved.
  return str.replace(goog.string.HTML_ENTITY_PATTERN_, function(s, entity) {
    // Check for cached entity.
    var value = seen[s];
    if (value) {
      return value;
    }
    // Check for numeric entity.
    if (entity.charAt(0) == '#') {
      // Prefix with 0 so that hex entities (e.g. &#x10) parse as hex numbers.
      var n = Number('0' + entity.substr(1));
      if (!isNaN(n)) {
        value = String.fromCharCode(n);
      }
    }
    // Fall back to innerHTML otherwise.
    if (!value) {
      // Append a non-entity character to avoid a bug in Webkit that parses
      // an invalid entity at the end of innerHTML text as the empty string.
      div.innerHTML = s + ' ';
      // Then remove the trailing character from the result.
      value = div.firstChild.nodeValue.slice(0, -1);
    }
    // Cache and return.
    return seen[s] = value;
  });
};


/**
 * Unescapes XML entities.
 * @private
 * @param {string} str The string to unescape.
 * @return {string} An unescaped copy of {@code str}.
 */
goog.string.unescapePureXmlEntities_ = function(str) {
  return str.replace(/&([^;]+);/g, function(s, entity) {
    switch (entity) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      default:
        if (entity.charAt(0) == '#') {
          // Prefix with 0 so that hex entities (e.g. &#x10) parse as hex.
          var n = Number('0' + entity.substr(1));
          if (!isNaN(n)) {
            return String.fromCharCode(n);
          }
        }
        // For invalid entities we just return the entity
        return s;
    }
  });
};


/**
 * Regular expression that matches an HTML entity.
 * See also HTML5: Tokenization / Tokenizing character references.
 * @private
 * @type {!RegExp}
 */
goog.string.HTML_ENTITY_PATTERN_ = /&([^;\s<&]+);?/g;


/**
 * Do escaping of whitespace to preserve spatial formatting. We use character
 * entity #160 to make it safer for xml.
 * @param {string} str The string in which to escape whitespace.
 * @param {boolean=} opt_xml Whether to use XML compatible tags.
 * @return {string} An escaped copy of {@code str}.
 */
goog.string.whitespaceEscape = function(str, opt_xml) {
  return goog.string.newLineToBr(str.replace(/  /g, ' &#160;'), opt_xml);
};


/**
 * Strip quote characters around a string.  The second argument is a string of
 * characters to treat as quotes.  This can be a single character or a string of
 * multiple character and in that case each of those are treated as possible
 * quote characters. For example:
 *
 * <pre>
 * goog.string.stripQuotes('"abc"', '"`') --> 'abc'
 * goog.string.stripQuotes('`abc`', '"`') --> 'abc'
 * </pre>
 *
 * @param {string} str The string to strip.
 * @param {string} quoteChars The quote characters to strip.
 * @return {string} A copy of {@code str} without the quotes.
 */
goog.string.stripQuotes = function(str, quoteChars) {
  var length = quoteChars.length;
  for (var i = 0; i < length; i++) {
    var quoteChar = length == 1 ? quoteChars : quoteChars.charAt(i);
    if (str.charAt(0) == quoteChar && str.charAt(str.length - 1) == quoteChar) {
      return str.substring(1, str.length - 1);
    }
  }
  return str;
};


/**
 * Truncates a string to a certain length and adds '...' if necessary.  The
 * length also accounts for the ellipsis, so a maximum length of 10 and a string
 * 'Hello World!' produces 'Hello W...'.
 * @param {string} str The string to truncate.
 * @param {number} chars Max number of characters.
 * @param {boolean=} opt_protectEscapedCharacters Whether to protect escaped
 *     characters from being cut off in the middle.
 * @return {string} The truncated {@code str} string.
 */
goog.string.truncate = function(str, chars, opt_protectEscapedCharacters) {
  if (opt_protectEscapedCharacters) {
    str = goog.string.unescapeEntities(str);
  }

  if (str.length > chars) {
    str = str.substring(0, chars - 3) + '...';
  }

  if (opt_protectEscapedCharacters) {
    str = goog.string.htmlEscape(str);
  }

  return str;
};


/**
 * Truncate a string in the middle, adding "..." if necessary,
 * and favoring the beginning of the string.
 * @param {string} str The string to truncate the middle of.
 * @param {number} chars Max number of characters.
 * @param {boolean=} opt_protectEscapedCharacters Whether to protect escaped
 *     characters from being cutoff in the middle.
 * @param {number=} opt_trailingChars Optional number of trailing characters to
 *     leave at the end of the string, instead of truncating as close to the
 *     middle as possible.
 * @return {string} A truncated copy of {@code str}.
 */
goog.string.truncateMiddle = function(str, chars,
    opt_protectEscapedCharacters, opt_trailingChars) {
  if (opt_protectEscapedCharacters) {
    str = goog.string.unescapeEntities(str);
  }

  if (opt_trailingChars && str.length > chars) {
    if (opt_trailingChars > chars) {
      opt_trailingChars = chars;
    }
    var endPoint = str.length - opt_trailingChars;
    var startPoint = chars - opt_trailingChars;
    str = str.substring(0, startPoint) + '...' + str.substring(endPoint);
  } else if (str.length > chars) {
    // Favor the beginning of the string:
    var half = Math.floor(chars / 2);
    var endPos = str.length - half;
    half += chars % 2;
    str = str.substring(0, half) + '...' + str.substring(endPos);
  }

  if (opt_protectEscapedCharacters) {
    str = goog.string.htmlEscape(str);
  }

  return str;
};


/**
 * Special chars that need to be escaped for goog.string.quote.
 * @private
 * @type {Object}
 */
goog.string.specialEscapeChars_ = {
  '\0': '\\0',
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\x0B': '\\x0B', // '\v' is not supported in JScript
  '"': '\\"',
  '\\': '\\\\'
};


/**
 * Character mappings used internally for goog.string.escapeChar.
 * @private
 * @type {Object}
 */
goog.string.jsEscapeCache_ = {
  '\'': '\\\''
};


/**
 * Encloses a string in double quotes and escapes characters so that the
 * string is a valid JS string.
 * @param {string} s The string to quote.
 * @return {string} A copy of {@code s} surrounded by double quotes.
 */
goog.string.quote = function(s) {
  s = String(s);
  if (s.quote) {
    return s.quote();
  } else {
    var sb = ['"'];
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      var cc = ch.charCodeAt(0);
      sb[i + 1] = goog.string.specialEscapeChars_[ch] ||
          ((cc > 31 && cc < 127) ? ch : goog.string.escapeChar(ch));
    }
    sb.push('"');
    return sb.join('');
  }
};


/**
 * Takes a string and returns the escaped string for that character.
 * @param {string} str The string to escape.
 * @return {string} An escaped string representing {@code str}.
 */
goog.string.escapeString = function(str) {
  var sb = [];
  for (var i = 0; i < str.length; i++) {
    sb[i] = goog.string.escapeChar(str.charAt(i));
  }
  return sb.join('');
};


/**
 * Takes a character and returns the escaped string for that character. For
 * example escapeChar(String.fromCharCode(15)) -> "\\x0E".
 * @param {string} c The character to escape.
 * @return {string} An escaped string representing {@code c}.
 */
goog.string.escapeChar = function(c) {
  if (c in goog.string.jsEscapeCache_) {
    return goog.string.jsEscapeCache_[c];
  }

  if (c in goog.string.specialEscapeChars_) {
    return goog.string.jsEscapeCache_[c] = goog.string.specialEscapeChars_[c];
  }

  var rv = c;
  var cc = c.charCodeAt(0);
  if (cc > 31 && cc < 127) {
    rv = c;
  } else {
    // tab is 9 but handled above
    if (cc < 256) {
      rv = '\\x';
      if (cc < 16 || cc > 256) {
        rv += '0';
      }
    } else {
      rv = '\\u';
      if (cc < 4096) { // \u1000
        rv += '0';
      }
    }
    rv += cc.toString(16).toUpperCase();
  }

  return goog.string.jsEscapeCache_[c] = rv;
};


/**
 * Takes a string and creates a map (Object) in which the keys are the
 * characters in the string. The value for the key is set to true. You can
 * then use goog.object.map or goog.array.map to change the values.
 * @param {string} s The string to build the map from.
 * @return {Object} The map of characters used.
 */
// TODO(arv): It seems like we should have a generic goog.array.toMap. But do
//            we want a dependency on goog.array in goog.string?
goog.string.toMap = function(s) {
  var rv = {};
  for (var i = 0; i < s.length; i++) {
    rv[s.charAt(i)] = true;
  }
  return rv;
};


/**
 * Checks whether a string contains a given substring.
 * @param {string} s The string to test.
 * @param {string} ss The substring to test for.
 * @return {boolean} True if {@code s} contains {@code ss}.
 */
goog.string.contains = function(s, ss) {
  return s.indexOf(ss) != -1;
};


/**
 * Returns the non-overlapping occurrences of ss in s.
 * If either s or ss evalutes to false, then returns zero.
 * @param {string} s The string to look in.
 * @param {string} ss The string to look for.
 * @return {number} Number of occurrences of ss in s.
 */
goog.string.countOf = function(s, ss) {
  return s && ss ? s.split(ss).length - 1 : 0;
};


/**
 * Removes a substring of a specified length at a specific
 * index in a string.
 * @param {string} s The base string from which to remove.
 * @param {number} index The index at which to remove the substring.
 * @param {number} stringLength The length of the substring to remove.
 * @return {string} A copy of {@code s} with the substring removed or the full
 *     string if nothing is removed or the input is invalid.
 */
goog.string.removeAt = function(s, index, stringLength) {
  var resultStr = s;
  // If the index is greater or equal to 0 then remove substring
  if (index >= 0 && index < s.length && stringLength > 0) {
    resultStr = s.substr(0, index) +
        s.substr(index + stringLength, s.length - index - stringLength);
  }
  return resultStr;
};


/**
 *  Removes the first occurrence of a substring from a string.
 *  @param {string} s The base string from which to remove.
 *  @param {string} ss The string to remove.
 *  @return {string} A copy of {@code s} with {@code ss} removed or the full
 *      string if nothing is removed.
 */
goog.string.remove = function(s, ss) {
  var re = new RegExp(goog.string.regExpEscape(ss), '');
  return s.replace(re, '');
};


/**
 *  Removes all occurrences of a substring from a string.
 *  @param {string} s The base string from which to remove.
 *  @param {string} ss The string to remove.
 *  @return {string} A copy of {@code s} with {@code ss} removed or the full
 *      string if nothing is removed.
 */
goog.string.removeAll = function(s, ss) {
  var re = new RegExp(goog.string.regExpEscape(ss), 'g');
  return s.replace(re, '');
};


/**
 * Escapes characters in the string that are not safe to use in a RegExp.
 * @param {*} s The string to escape. If not a string, it will be casted
 *     to one.
 * @return {string} A RegExp safe, escaped copy of {@code s}.
 */
goog.string.regExpEscape = function(s) {
  return String(s).replace(/([-()\[\]{}+?*.$\^|,:#<!\\])/g, '\\$1').
      replace(/\x08/g, '\\x08');
};


/**
 * Repeats a string n times.
 * @param {string} string The string to repeat.
 * @param {number} length The number of times to repeat.
 * @return {string} A string containing {@code length} repetitions of
 *     {@code string}.
 */
goog.string.repeat = function(string, length) {
  return new Array(length + 1).join(string);
};


/**
 * Pads number to given length and optionally rounds it to a given precision.
 * For example:
 * <pre>padNumber(1.25, 2, 3) -> '01.250'
 * padNumber(1.25, 2) -> '01.25'
 * padNumber(1.25, 2, 1) -> '01.3'
 * padNumber(1.25, 0) -> '1.25'</pre>
 *
 * @param {number} num The number to pad.
 * @param {number} length The desired length.
 * @param {number=} opt_precision The desired precision.
 * @return {string} {@code num} as a string with the given options.
 */
goog.string.padNumber = function(num, length, opt_precision) {
  var s = goog.isDef(opt_precision) ? num.toFixed(opt_precision) : String(num);
  var index = s.indexOf('.');
  if (index == -1) {
    index = s.length;
  }
  return goog.string.repeat('0', Math.max(0, length - index)) + s;
};


/**
 * Returns a string representation of the given object, with
 * null and undefined being returned as the empty string.
 *
 * @param {*} obj The object to convert.
 * @return {string} A string representation of the {@code obj}.
 */
goog.string.makeSafe = function(obj) {
  return obj == null ? '' : String(obj);
};


/**
 * Concatenates string expressions. This is useful
 * since some browsers are very inefficient when it comes to using plus to
 * concat strings. Be careful when using null and undefined here since
 * these will not be included in the result. If you need to represent these
 * be sure to cast the argument to a String first.
 * For example:
 * <pre>buildString('a', 'b', 'c', 'd') -> 'abcd'
 * buildString(null, undefined) -> ''
 * </pre>
 * @param {...*} var_args A list of strings to concatenate. If not a string,
 *     it will be casted to one.
 * @return {string} The concatenation of {@code var_args}.
 */
goog.string.buildString = function(var_args) {
  return Array.prototype.join.call(arguments, '');
};


/**
 * Returns a string with at least 64-bits of randomness.
 *
 * Doesn't trust Javascript's random function entirely. Uses a combination of
 * random and current timestamp, and then encodes the string in base-36 to
 * make it shorter.
 *
 * @return {string} A random string, e.g. sn1s7vb4gcic.
 */
goog.string.getRandomString = function() {
  var x = 2147483648;
  return Math.floor(Math.random() * x).toString(36) +
         Math.abs(Math.floor(Math.random() * x) ^ goog.now()).toString(36);
};


/**
 * Compares two version numbers.
 *
 * @param {string|number} version1 Version of first item.
 * @param {string|number} version2 Version of second item.
 *
 * @return {number}  1 if {@code version1} is higher.
 *                   0 if arguments are equal.
 *                  -1 if {@code version2} is higher.
 */
goog.string.compareVersions = function(version1, version2) {
  var order = 0;
  // Trim leading and trailing whitespace and split the versions into
  // subversions.
  var v1Subs = goog.string.trim(String(version1)).split('.');
  var v2Subs = goog.string.trim(String(version2)).split('.');
  var subCount = Math.max(v1Subs.length, v2Subs.length);

  // Iterate over the subversions, as long as they appear to be equivalent.
  for (var subIdx = 0; order == 0 && subIdx < subCount; subIdx++) {
    var v1Sub = v1Subs[subIdx] || '';
    var v2Sub = v2Subs[subIdx] || '';

    // Split the subversions into pairs of numbers and qualifiers (like 'b').
    // Two different RegExp objects are needed because they are both using
    // the 'g' flag.
    var v1CompParser = new RegExp('(\\d*)(\\D*)', 'g');
    var v2CompParser = new RegExp('(\\d*)(\\D*)', 'g');
    do {
      var v1Comp = v1CompParser.exec(v1Sub) || ['', '', ''];
      var v2Comp = v2CompParser.exec(v2Sub) || ['', '', ''];
      // Break if there are no more matches.
      if (v1Comp[0].length == 0 && v2Comp[0].length == 0) {
        break;
      }

      // Parse the numeric part of the subversion. A missing number is
      // equivalent to 0.
      var v1CompNum = v1Comp[1].length == 0 ? 0 : parseInt(v1Comp[1], 10);
      var v2CompNum = v2Comp[1].length == 0 ? 0 : parseInt(v2Comp[1], 10);

      // Compare the subversion components. The number has the highest
      // precedence. Next, if the numbers are equal, a subversion without any
      // qualifier is always higher than a subversion with any qualifier. Next,
      // the qualifiers are compared as strings.
      order = goog.string.compareElements_(v1CompNum, v2CompNum) ||
          goog.string.compareElements_(v1Comp[2].length == 0,
              v2Comp[2].length == 0) ||
          goog.string.compareElements_(v1Comp[2], v2Comp[2]);
      // Stop as soon as an inequality is discovered.
    } while (order == 0);
  }

  return order;
};


/**
 * Compares elements of a version number.
 *
 * @param {string|number|boolean} left An element from a version number.
 * @param {string|number|boolean} right An element from a version number.
 *
 * @return {number}  1 if {@code left} is higher.
 *                   0 if arguments are equal.
 *                  -1 if {@code right} is higher.
 * @private
 */
goog.string.compareElements_ = function(left, right) {
  if (left < right) {
    return -1;
  } else if (left > right) {
    return 1;
  }
  return 0;
};


/**
 * Maximum value of #goog.string.hashCode, exclusive. 2^32.
 * @type {number}
 * @private
 */
goog.string.HASHCODE_MAX_ = 0x100000000;


/**
 * String hash function similar to java.lang.String.hashCode().
 * The hash code for a string is computed as
 * s[0] * 31 ^ (n - 1) + s[1] * 31 ^ (n - 2) + ... + s[n - 1],
 * where s[i] is the ith character of the string and n is the length of
 * the string. We mod the result to make it between 0 (inclusive) and 2^32
 * (exclusive).
 * @param {string} str A string.
 * @return {number} Hash value for {@code str}, between 0 (inclusive) and 2^32
 *  (exclusive). The empty string returns 0.
 */
goog.string.hashCode = function(str) {
  var result = 0;
  for (var i = 0; i < str.length; ++i) {
    result = 31 * result + str.charCodeAt(i);
    // Normalize to 4 byte range, 0 ... 2^32.
    result %= goog.string.HASHCODE_MAX_;
  }
  return result;
};


/**
 * The most recent unique ID. |0 is equivalent to Math.floor in this case.
 * @type {number}
 * @private
 */
goog.string.uniqueStringCounter_ = Math.random() * 0x80000000 | 0;


/**
 * Generates and returns a string which is unique in the current document.
 * This is useful, for example, to create unique IDs for DOM elements.
 * @return {string} A unique id.
 */
goog.string.createUniqueString = function() {
  return 'goog_' + goog.string.uniqueStringCounter_++;
};


/**
 * Converts the supplied string to a number, which may be Ininity or NaN.
 * This function strips whitespace: (toNumber(' 123') === 123)
 * This function accepts scientific notation: (toNumber('1e1') === 10)
 *
 * This is better than Javascript's built-in conversions because, sadly:
 *     (Number(' ') === 0) and (parseFloat('123a') === 123)
 *
 * @param {string} str The string to convert.
 * @return {number} The number the supplied string represents, or NaN.
 */
goog.string.toNumber = function(str) {
  var num = Number(str);
  if (num == 0 && goog.string.isEmpty(str)) {
    return NaN;
  }
  return num;
};


/**
 * Converts a string from selector-case to camelCase (e.g. from
 * "multi-part-string" to "multiPartString"), useful for converting
 * CSS selectors and HTML dataset keys to their equivalent JS properties.
 * @param {string} str The string in selector-case form.
 * @return {string} The string in camelCase form.
 */
goog.string.toCamelCase = function(str) {
  return String(str).replace(/\-([a-z])/g, function(all, match) {
    return match.toUpperCase();
  });
};


/**
 * Converts a string from camelCase to selector-case (e.g. from
 * "multiPartString" to "multi-part-string"), useful for converting JS
 * style and dataset properties to equivalent CSS selectors and HTML keys.
 * @param {string} str The string in camelCase form.
 * @return {string} The string in selector-case form.
 */
goog.string.toSelectorCase = function(str) {
  return String(str).replace(/([A-Z])/g, '-$1').toLowerCase();
};


/**
 * Converts a string into TitleCase. First character of the string is always
 * capitalized in addition to the first letter of every subsequent word.
 * Words are delimited by one or more whitespaces by default. Custom delimiters
 * can optionally be specified to replace the default, which doesn't preserve
 * whitespace delimiters and instead must be explicitly included if needed.
 *
 * Default delimiter => " ":
 *    goog.string.toTitleCase('oneTwoThree')    => 'OneTwoThree'
 *    goog.string.toTitleCase('one two three')  => 'One Two Three'
 *    goog.string.toTitleCase('  one   two   ') => '  One   Two   '
 *    goog.string.toTitleCase('one_two_three')  => 'One_two_three'
 *    goog.string.toTitleCase('one-two-three')  => 'One-two-three'
 *
 * Custom delimiter => "_-.":
 *    goog.string.toTitleCase('oneTwoThree', '_-.')       => 'OneTwoThree'
 *    goog.string.toTitleCase('one two three', '_-.')     => 'One two three'
 *    goog.string.toTitleCase('  one   two   ', '_-.')    => '  one   two   '
 *    goog.string.toTitleCase('one_two_three', '_-.')     => 'One_Two_Three'
 *    goog.string.toTitleCase('one-two-three', '_-.')     => 'One-Two-Three'
 *    goog.string.toTitleCase('one...two...three', '_-.') => 'One...Two...Three'
 *    goog.string.toTitleCase('one. two. three', '_-.')   => 'One. two. three'
 *    goog.string.toTitleCase('one-two.three', '_-.')     => 'One-Two.Three'
 *
 * @param {string} str String value in camelCase form.
 * @param {string=} opt_delimiters Custom delimiter character set used to
 *      distinguish words in the string value. Each character represents a
 *      single delimiter. When provided, default whitespace delimiter is
 *      overridden and must be explicitly included if needed.
 * @return {string} String value in TitleCase form.
 */
goog.string.toTitleCase = function(str, opt_delimiters) {
  var delimiters = goog.isString(opt_delimiters) ?
      goog.string.regExpEscape(opt_delimiters) : '\\s';

  // For IE8, we need to prevent using an empty character set. Otherwise,
  // incorrect matching will occur.
  delimiters = delimiters ? '|[' + delimiters + ']+' : '';

  var regexp = new RegExp('(^' + delimiters + ')([a-z])', 'g');
  return str.replace(regexp, function(all, p1, p2) {
    return p1 + p2.toUpperCase();
  });
};


/**
 * Parse a string in decimal or hexidecimal ('0xFFFF') form.
 *
 * To parse a particular radix, please use parseInt(string, radix) directly. See
 * https://developer.mozilla.org/en/JavaScript/Reference/Global_Objects/parseInt
 *
 * This is a wrapper for the built-in parseInt function that will only parse
 * numbers as base 10 or base 16.  Some JS implementations assume strings
 * starting with "0" are intended to be octal. ES3 allowed but discouraged
 * this behavior. ES5 forbids it.  This function emulates the ES5 behavior.
 *
 * For more information, see Mozilla JS Reference: http://goo.gl/8RiFj
 *
 * @param {string|number|null|undefined} value The value to be parsed.
 * @return {number} The number, parsed. If the string failed to parse, this
 *     will be NaN.
 */
goog.string.parseInt = function(value) {
  // Force finite numbers to strings.
  if (isFinite(value)) {
    value = String(value);
  }

  if (goog.isString(value)) {
    // If the string starts with '0x' or '-0x', parse as hex.
    return /^\s*-?0x/i.test(value) ?
        parseInt(value, 16) : parseInt(value, 10);
  }

  return NaN;
};

// Copyright 2009 The Closure Library Authors. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS-IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * @fileoverview Provides a base class for custom Error objects such that the
 * stack is correctly maintained.
 *
 * You should never need to throw goog.debug.Error(msg) directly, Error(msg) is
 * sufficient.
 *
 */

goog.provide('goog.debug.Error');



/**
 * Base class for custom error objects.
 * @param {*=} opt_msg The message associated with the error.
 * @constructor
 * @extends {Error}
 */
goog.debug.Error = function(opt_msg) {

  // Ensure there is a stack trace.
  if (Error.captureStackTrace) {
    Error.captureStackTrace(this, goog.debug.Error);
  } else {
    this.stack = new Error().stack || '';
  }

  if (opt_msg) {
    this.message = String(opt_msg);
  }
};
goog.inherits(goog.debug.Error, Error);


/** @override */
goog.debug.Error.prototype.name = 'CustomError';

// Copyright 2008 The Closure Library Authors. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS-IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * @fileoverview Utilities to check the preconditions, postconditions and
 * invariants runtime.
 *
 * Methods in this package should be given special treatment by the compiler
 * for type-inference. For example, <code>goog.asserts.assert(foo)</code>
 * will restrict <code>foo</code> to a truthy value.
 *
 * The compiler has an option to disable asserts. So code like:
 * <code>
 * var x = goog.asserts.assert(foo()); goog.asserts.assert(bar());
 * </code>
 * will be transformed into:
 * <code>
 * var x = foo();
 * </code>
 * The compiler will leave in foo() (because its return value is used),
 * but it will remove bar() because it assumes it does not have side-effects.
 *
 */

goog.provide('goog.asserts');
goog.provide('goog.asserts.AssertionError');

goog.require('goog.debug.Error');
goog.require('goog.string');


/**
 * @define {boolean} Whether to strip out asserts or to leave them in.
 */
goog.asserts.ENABLE_ASSERTS = goog.DEBUG;



/**
 * Error object for failed assertions.
 * @param {string} messagePattern The pattern that was used to form message.
 * @param {!Array.<*>} messageArgs The items to substitute into the pattern.
 * @constructor
 * @extends {goog.debug.Error}
 */
goog.asserts.AssertionError = function(messagePattern, messageArgs) {
  messageArgs.unshift(messagePattern);
  goog.debug.Error.call(this, goog.string.subs.apply(null, messageArgs));
  // Remove the messagePattern afterwards to avoid permenantly modifying the
  // passed in array.
  messageArgs.shift();

  /**
   * The message pattern used to format the error message. Error handlers can
   * use this to uniquely identify the assertion.
   * @type {string}
   */
  this.messagePattern = messagePattern;
};
goog.inherits(goog.asserts.AssertionError, goog.debug.Error);


/** @override */
goog.asserts.AssertionError.prototype.name = 'AssertionError';


/**
 * Throws an exception with the given message and "Assertion failed" prefixed
 * onto it.
 * @param {string} defaultMessage The message to use if givenMessage is empty.
 * @param {Array.<*>} defaultArgs The substitution arguments for defaultMessage.
 * @param {string|undefined} givenMessage Message supplied by the caller.
 * @param {Array.<*>} givenArgs The substitution arguments for givenMessage.
 * @throws {goog.asserts.AssertionError} When the value is not a number.
 * @private
 */
goog.asserts.doAssertFailure_ =
    function(defaultMessage, defaultArgs, givenMessage, givenArgs) {
  var message = 'Assertion failed';
  if (givenMessage) {
    message += ': ' + givenMessage;
    var args = givenArgs;
  } else if (defaultMessage) {
    message += ': ' + defaultMessage;
    args = defaultArgs;
  }
  // The '' + works around an Opera 10 bug in the unit tests. Without it,
  // a stack trace is added to var message above. With this, a stack trace is
  // not added until this line (it causes the extra garbage to be added after
  // the assertion message instead of in the middle of it).
  throw new goog.asserts.AssertionError('' + message, args || []);
};


/**
 * Checks if the condition evaluates to true if goog.asserts.ENABLE_ASSERTS is
 * true.
 * @param {*} condition The condition to check.
 * @param {string=} opt_message Error message in case of failure.
 * @param {...*} var_args The items to substitute into the failure message.
 * @return {*} The value of the condition.
 * @throws {goog.asserts.AssertionError} When the condition evaluates to false.
 */
goog.asserts.assert = function(condition, opt_message, var_args) {
  if (goog.asserts.ENABLE_ASSERTS && !condition) {
    goog.asserts.doAssertFailure_('', null, opt_message,
        Array.prototype.slice.call(arguments, 2));
  }
  return condition;
};


/**
 * Fails if goog.asserts.ENABLE_ASSERTS is true. This function is useful in case
 * when we want to add a check in the unreachable area like switch-case
 * statement:
 *
 * <pre>
 *  switch(type) {
 *    case FOO: doSomething(); break;
 *    case BAR: doSomethingElse(); break;
 *    default: goog.assert.fail('Unrecognized type: ' + type);
 *      // We have only 2 types - "default:" section is unreachable code.
 *  }
 * </pre>
 *
 * @param {string=} opt_message Error message in case of failure.
 * @param {...*} var_args The items to substitute into the failure message.
 * @throws {goog.asserts.AssertionError} Failure.
 */
goog.asserts.fail = function(opt_message, var_args) {
  if (goog.asserts.ENABLE_ASSERTS) {
    throw new goog.asserts.AssertionError(
        'Failure' + (opt_message ? ': ' + opt_message : ''),
        Array.prototype.slice.call(arguments, 1));
  }
};


/**
 * Checks if the value is a number if goog.asserts.ENABLE_ASSERTS is true.
 * @param {*} value The value to check.
 * @param {string=} opt_message Error message in case of failure.
 * @param {...*} var_args The items to substitute into the failure message.
 * @return {number} The value, guaranteed to be a number when asserts enabled.
 * @throws {goog.asserts.AssertionError} When the value is not a number.
 */
goog.asserts.assertNumber = function(value, opt_message, var_args) {
  if (goog.asserts.ENABLE_ASSERTS && !goog.isNumber(value)) {
    goog.asserts.doAssertFailure_('Expected number but got %s: %s.',
        [goog.typeOf(value), value], opt_message,
        Array.prototype.slice.call(arguments, 2));
  }
  return /** @type {number} */ (value);
};


/**
 * Checks if the value is a string if goog.asserts.ENABLE_ASSERTS is true.
 * @param {*} value The value to check.
 * @param {string=} opt_message Error message in case of failure.
 * @param {...*} var_args The items to substitute into the failure message.
 * @return {string} The value, guaranteed to be a string when asserts enabled.
 * @throws {goog.asserts.AssertionError} When the value is not a string.
 */
goog.asserts.assertString = function(value, opt_message, var_args) {
  if (goog.asserts.ENABLE_ASSERTS && !goog.isString(value)) {
    goog.asserts.doAssertFailure_('Expected string but got %s: %s.',
        [goog.typeOf(value), value], opt_message,
        Array.prototype.slice.call(arguments, 2));
  }
  return /** @type {string} */ (value);
};


/**
 * Checks if the value is a function if goog.asserts.ENABLE_ASSERTS is true.
 * @param {*} value The value to check.
 * @param {string=} opt_message Error message in case of failure.
 * @param {...*} var_args The items to substitute into the failure message.
 * @return {!Function} The value, guaranteed to be a function when asserts
 *     enabled.
 * @throws {goog.asserts.AssertionError} When the value is not a function.
 */
goog.asserts.assertFunction = function(value, opt_message, var_args) {
  if (goog.asserts.ENABLE_ASSERTS && !goog.isFunction(value)) {
    goog.asserts.doAssertFailure_('Expected function but got %s: %s.',
        [goog.typeOf(value), value], opt_message,
        Array.prototype.slice.call(arguments, 2));
  }
  return /** @type {!Function} */ (value);
};


/**
 * Checks if the value is an Object if goog.asserts.ENABLE_ASSERTS is true.
 * @param {*} value The value to check.
 * @param {string=} opt_message Error message in case of failure.
 * @param {...*} var_args The items to substitute into the failure message.
 * @return {!Object} The value, guaranteed to be a non-null object.
 * @throws {goog.asserts.AssertionError} When the value is not an object.
 */
goog.asserts.assertObject = function(value, opt_message, var_args) {
  if (goog.asserts.ENABLE_ASSERTS && !goog.isObject(value)) {
    goog.asserts.doAssertFailure_('Expected object but got %s: %s.',
        [goog.typeOf(value), value],
        opt_message, Array.prototype.slice.call(arguments, 2));
  }
  return /** @type {!Object} */ (value);
};


/**
 * Checks if the value is an Array if goog.asserts.ENABLE_ASSERTS is true.
 * @param {*} value The value to check.
 * @param {string=} opt_message Error message in case of failure.
 * @param {...*} var_args The items to substitute into the failure message.
 * @return {!Array} The value, guaranteed to be a non-null array.
 * @throws {goog.asserts.AssertionError} When the value is not an array.
 */
goog.asserts.assertArray = function(value, opt_message, var_args) {
  if (goog.asserts.ENABLE_ASSERTS && !goog.isArray(value)) {
    goog.asserts.doAssertFailure_('Expected array but got %s: %s.',
        [goog.typeOf(value), value], opt_message,
        Array.prototype.slice.call(arguments, 2));
  }
  return /** @type {!Array} */ (value);
};


/**
 * Checks if the value is a boolean if goog.asserts.ENABLE_ASSERTS is true.
 * @param {*} value The value to check.
 * @param {string=} opt_message Error message in case of failure.
 * @param {...*} var_args The items to substitute into the failure message.
 * @return {boolean} The value, guaranteed to be a boolean when asserts are
 *     enabled.
 * @throws {goog.asserts.AssertionError} When the value is not a boolean.
 */
goog.asserts.assertBoolean = function(value, opt_message, var_args) {
  if (goog.asserts.ENABLE_ASSERTS && !goog.isBoolean(value)) {
    goog.asserts.doAssertFailure_('Expected boolean but got %s: %s.',
        [goog.typeOf(value), value], opt_message,
        Array.prototype.slice.call(arguments, 2));
  }
  return /** @type {boolean} */ (value);
};


/**
 * Checks if the value is an instance of the user-defined type if
 * goog.asserts.ENABLE_ASSERTS is true.
 *
 * The compiler may tighten the type returned by this function.
 *
 * @param {*} value The value to check.
 * @param {!Function} type A user-defined constructor.
 * @param {string=} opt_message Error message in case of failure.
 * @param {...*} var_args The items to substitute into the failure message.
 * @throws {goog.asserts.AssertionError} When the value is not an instance of
 *     type.
 * @return {!Object}
 */
goog.asserts.assertInstanceof = function(value, type, opt_message, var_args) {
  if (goog.asserts.ENABLE_ASSERTS && !(value instanceof type)) {
    goog.asserts.doAssertFailure_('instanceof check failed.', null,
        opt_message, Array.prototype.slice.call(arguments, 3));
  }
  return /** @type {!Object} */(value);
};


// Copyright 2006 The Closure Library Authors. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS-IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * @fileoverview Utilities for manipulating arrays.
 *
 */


goog.provide('goog.array');
goog.provide('goog.array.ArrayLike');

goog.require('goog.asserts');


/**
 * @define {boolean} NATIVE_ARRAY_PROTOTYPES indicates whether the code should
 * rely on Array.prototype functions, if available.
 *
 * The Array.prototype functions can be defined by external libraries like
 * Prototype and setting this flag to false forces closure to use its own
 * goog.array implementation.
 *
 * If your javascript can be loaded by a third party site and you are wary about
 * relying on the prototype functions, specify
 * "--define goog.NATIVE_ARRAY_PROTOTYPES=false" to the JSCompiler.
 */
goog.NATIVE_ARRAY_PROTOTYPES = true;


/**
 * @typedef {Array|NodeList|Arguments|{length: number}}
 */
goog.array.ArrayLike;


/**
 * Returns the last element in an array without removing it.
 * @param {goog.array.ArrayLike} array The array.
 * @return {*} Last item in array.
 */
goog.array.peek = function(array) {
  return array[array.length - 1];
};


/**
 * Reference to the original {@code Array.prototype}.
 * @private
 */
goog.array.ARRAY_PROTOTYPE_ = Array.prototype;


// NOTE(arv): Since most of the array functions are generic it allows you to
// pass an array-like object. Strings have a length and are considered array-
// like. However, the 'in' operator does not work on strings so we cannot just
// use the array path even if the browser supports indexing into strings. We
// therefore end up splitting the string.


/**
 * Returns the index of the first element of an array with a specified
 * value, or -1 if the element is not present in the array.
 *
 * See {@link http://tinyurl.com/developer-mozilla-org-array-indexof}
 *
 * @param {goog.array.ArrayLike} arr The array to be searched.
 * @param {*} obj The object for which we are searching.
 * @param {number=} opt_fromIndex The index at which to start the search. If
 *     omitted the search starts at index 0.
 * @return {number} The index of the first matching array element.
 */
goog.array.indexOf = goog.NATIVE_ARRAY_PROTOTYPES &&
                     goog.array.ARRAY_PROTOTYPE_.indexOf ?
    function(arr, obj, opt_fromIndex) {
      goog.asserts.assert(arr.length != null);

      return goog.array.ARRAY_PROTOTYPE_.indexOf.call(arr, obj, opt_fromIndex);
    } :
    function(arr, obj, opt_fromIndex) {
      var fromIndex = opt_fromIndex == null ?
          0 : (opt_fromIndex < 0 ?
               Math.max(0, arr.length + opt_fromIndex) : opt_fromIndex);

      if (goog.isString(arr)) {
        // Array.prototype.indexOf uses === so only strings should be found.
        if (!goog.isString(obj) || obj.length != 1) {
          return -1;
        }
        return arr.indexOf(obj, fromIndex);
      }

      for (var i = fromIndex; i < arr.length; i++) {
        if (i in arr && arr[i] === obj)
          return i;
      }
      return -1;
    };


/**
 * Returns the index of the last element of an array with a specified value, or
 * -1 if the element is not present in the array.
 *
 * See {@link http://tinyurl.com/developer-mozilla-org-array-lastindexof}
 *
 * @param {goog.array.ArrayLike} arr The array to be searched.
 * @param {*} obj The object for which we are searching.
 * @param {?number=} opt_fromIndex The index at which to start the search. If
 *     omitted the search starts at the end of the array.
 * @return {number} The index of the last matching array element.
 */
goog.array.lastIndexOf = goog.NATIVE_ARRAY_PROTOTYPES &&
                         goog.array.ARRAY_PROTOTYPE_.lastIndexOf ?
    function(arr, obj, opt_fromIndex) {
      goog.asserts.assert(arr.length != null);

      // Firefox treats undefined and null as 0 in the fromIndex argument which
      // leads it to always return -1
      var fromIndex = opt_fromIndex == null ? arr.length - 1 : opt_fromIndex;
      return goog.array.ARRAY_PROTOTYPE_.lastIndexOf.call(arr, obj, fromIndex);
    } :
    function(arr, obj, opt_fromIndex) {
      var fromIndex = opt_fromIndex == null ? arr.length - 1 : opt_fromIndex;

      if (fromIndex < 0) {
        fromIndex = Math.max(0, arr.length + fromIndex);
      }

      if (goog.isString(arr)) {
        // Array.prototype.lastIndexOf uses === so only strings should be found.
        if (!goog.isString(obj) || obj.length != 1) {
          return -1;
        }
        return arr.lastIndexOf(obj, fromIndex);
      }

      for (var i = fromIndex; i >= 0; i--) {
        if (i in arr && arr[i] === obj)
          return i;
      }
      return -1;
    };


/**
 * Calls a function for each element in an array. Skips holes in the array.
 * See {@link http://tinyurl.com/developer-mozilla-org-array-foreach}
 *
 * @param {Array.<T>|goog.array.ArrayLike} arr Array or array like object over
 *     which to iterate.
 * @param {?function(this: S, T, number, ?): ?} f The function to call for every
 *     element. This function takes 3 arguments (the element, the index and the
 *     array). The return value is ignored.
 * @param {S=} opt_obj The object to be used as the value of 'this' within f.
 * @template T,S
 */
goog.array.forEach = goog.NATIVE_ARRAY_PROTOTYPES &&
                     goog.array.ARRAY_PROTOTYPE_.forEach ?
    function(arr, f, opt_obj) {
      goog.asserts.assert(arr.length != null);

      goog.array.ARRAY_PROTOTYPE_.forEach.call(arr, f, opt_obj);
    } :
    function(arr, f, opt_obj) {
      var l = arr.length;  // must be fixed during loop... see docs
      var arr2 = goog.isString(arr) ? arr.split('') : arr;
      for (var i = 0; i < l; i++) {
        if (i in arr2) {
          f.call(opt_obj, arr2[i], i, arr);
        }
      }
    };


/**
 * Calls a function for each element in an array, starting from the last
 * element rather than the first.
 *
 * @param {Array.<T>|goog.array.ArrayLike} arr Array or array
 *     like object over which to iterate.
 * @param {?function(this: S, T, number, ?): ?} f The function to call for every
 *     element. This function
 *     takes 3 arguments (the element, the index and the array). The return
 *     value is ignored.
 * @param {S=} opt_obj The object to be used as the value of 'this'
 *     within f.
 * @template T,S
 */
goog.array.forEachRight = function(arr, f, opt_obj) {
  var l = arr.length;  // must be fixed during loop... see docs
  var arr2 = goog.isString(arr) ? arr.split('') : arr;
  for (var i = l - 1; i >= 0; --i) {
    if (i in arr2) {
      f.call(opt_obj, arr2[i], i, arr);
    }
  }
};


/**
 * Calls a function for each element in an array, and if the function returns
 * true adds the element to a new array.
 *
 * See {@link http://tinyurl.com/developer-mozilla-org-array-filter}
 *
 * @param {Array.<T>|goog.array.ArrayLike} arr Array or array
 *     like object over which to iterate.
 * @param {?function(this:S, T, number, ?):boolean} f The function to call for
 *     every element. This function
 *     takes 3 arguments (the element, the index and the array) and must
 *     return a Boolean. If the return value is true the element is added to the
 *     result array. If it is false the element is not included.
 * @param {S=} opt_obj The object to be used as the value of 'this'
 *     within f.
 * @return {!Array} a new array in which only elements that passed the test are
 *     present.
 * @template T,S
 */
goog.array.filter = goog.NATIVE_ARRAY_PROTOTYPES &&
                    goog.array.ARRAY_PROTOTYPE_.filter ?
    function(arr, f, opt_obj) {
      goog.asserts.assert(arr.length != null);

      return goog.array.ARRAY_PROTOTYPE_.filter.call(arr, f, opt_obj);
    } :
    function(arr, f, opt_obj) {
      var l = arr.length;  // must be fixed during loop... see docs
      var res = [];
      var resLength = 0;
      var arr2 = goog.isString(arr) ? arr.split('') : arr;
      for (var i = 0; i < l; i++) {
        if (i in arr2) {
          var val = arr2[i];  // in case f mutates arr2
          if (f.call(opt_obj, val, i, arr)) {
            res[resLength++] = val;
          }
        }
      }
      return res;
    };


/**
 * Calls a function for each element in an array and inserts the result into a
 * new array.
 *
 * See {@link http://tinyurl.com/developer-mozilla-org-array-map}
 *
 * @param {Array.<T>|goog.array.ArrayLike} arr Array or array
 *     like object over which to iterate.
 * @param {?function(this:S, T, number, ?):?} f The function to call for every
 *     element. This function
 *     takes 3 arguments (the element, the index and the array) and should
 *     return something. The result will be inserted into a new array.
 * @param {S=} opt_obj The object to be used as the value of 'this'
 *     within f.
 * @return {!Array} a new array with the results from f.
 * @template T,S
 */
goog.array.map = goog.NATIVE_ARRAY_PROTOTYPES &&
                 goog.array.ARRAY_PROTOTYPE_.map ?
    function(arr, f, opt_obj) {
      goog.asserts.assert(arr.length != null);

      return goog.array.ARRAY_PROTOTYPE_.map.call(arr, f, opt_obj);
    } :
    function(arr, f, opt_obj) {
      var l = arr.length;  // must be fixed during loop... see docs
      var res = new Array(l);
      var arr2 = goog.isString(arr) ? arr.split('') : arr;
      for (var i = 0; i < l; i++) {
        if (i in arr2) {
          res[i] = f.call(opt_obj, arr2[i], i, arr);
        }
      }
      return res;
    };


/**
 * Passes every element of an array into a function and accumulates the result.
 *
 * See {@link http://tinyurl.com/developer-mozilla-org-array-reduce}
 *
 * For example:
 * var a = [1, 2, 3, 4];
 * goog.array.reduce(a, function(r, v, i, arr) {return r + v;}, 0);
 * returns 10
 *
 * @param {Array.<T>|goog.array.ArrayLike} arr Array or array
 *     like object over which to iterate.
 * @param {?function(this:S, R, T, number, ?) : R} f The function to call for
 *     every element. This function
 *     takes 4 arguments (the function's previous result or the initial value,
 *     the value of the current array element, the current array index, and the
 *     array itself)
 *     function(previousValue, currentValue, index, array).
 * @param {?} val The initial value to pass into the function on the first call.
 * @param {S=} opt_obj  The object to be used as the value of 'this'
 *     within f.
 * @return {R} Result of evaluating f repeatedly across the values of the array.
 * @template T,S,R
 */
goog.array.reduce = function(arr, f, val, opt_obj) {
  if (arr.reduce) {
    if (opt_obj) {
      return arr.reduce(goog.bind(f, opt_obj), val);
    } else {
      return arr.reduce(f, val);
    }
  }
  var rval = val;
  goog.array.forEach(arr, function(val, index) {
    rval = f.call(opt_obj, rval, val, index, arr);
  });
  return rval;
};


/**
 * Passes every element of an array into a function and accumulates the result,
 * starting from the last element and working towards the first.
 *
 * See {@link http://tinyurl.com/developer-mozilla-org-array-reduceright}
 *
 * For example:
 * var a = ['a', 'b', 'c'];
 * goog.array.reduceRight(a, function(r, v, i, arr) {return r + v;}, '');
 * returns 'cba'
 *
 * @param {Array.<T>|goog.array.ArrayLike} arr Array or array
 *     like object over which to iterate.
 * @param {?function(this:S, R, T, number, ?) : R} f The function to call for
 *     every element. This function
 *     takes 4 arguments (the function's previous result or the initial value,
 *     the value of the current array element, the current array index, and the
 *     array itself)
 *     function(previousValue, currentValue, index, array).
 * @param {?} val The initial value to pass into the function on the first call.
 * @param {S=} opt_obj The object to be used as the value of 'this'
 *     within f.
 * @return {R} Object returned as a result of evaluating f repeatedly across the
 *     values of the array.
 * @template T,S,R
 */
goog.array.reduceRight = function(arr, f, val, opt_obj) {
  if (arr.reduceRight) {
    if (opt_obj) {
      return arr.reduceRight(goog.bind(f, opt_obj), val);
    } else {
      return arr.reduceRight(f, val);
    }
  }
  var rval = val;
  goog.array.forEachRight(arr, function(val, index) {
    rval = f.call(opt_obj, rval, val, index, arr);
  });
  return rval;
};


/**
 * Calls f for each element of an array. If any call returns true, some()
 * returns true (without checking the remaining elements). If all calls
 * return false, some() returns false.
 *
 * See {@link http://tinyurl.com/developer-mozilla-org-array-some}
 *
 * @param {Array.<T>|goog.array.ArrayLike} arr Array or array
 *     like object over which to iterate.
 * @param {?function(this:S, T, number, ?) : boolean} f The function to call for
 *     for every element. This function takes 3 arguments (the element, the
 *     index and the array) and should return a boolean.
 * @param {S=} opt_obj  The object to be used as the value of 'this'
 *     within f.
 * @return {boolean} true if any element passes the test.
 * @template T,S
 */
goog.array.some = goog.NATIVE_ARRAY_PROTOTYPES &&
                  goog.array.ARRAY_PROTOTYPE_.some ?
    function(arr, f, opt_obj) {
      goog.asserts.assert(arr.length != null);

      return goog.array.ARRAY_PROTOTYPE_.some.call(arr, f, opt_obj);
    } :
    function(arr, f, opt_obj) {
      var l = arr.length;  // must be fixed during loop... see docs
      var arr2 = goog.isString(arr) ? arr.split('') : arr;
      for (var i = 0; i < l; i++) {
        if (i in arr2 && f.call(opt_obj, arr2[i], i, arr)) {
          return true;
        }
      }
      return false;
    };


/**
 * Call f for each element of an array. If all calls return true, every()
 * returns true. If any call returns false, every() returns false and
 * does not continue to check the remaining elements.
 *
 * See {@link http://tinyurl.com/developer-mozilla-org-array-every}
 *
 * @param {Array.<T>|goog.array.ArrayLike} arr Array or array
 *     like object over which to iterate.
 * @param {?function(this:S, T, number, ?) : boolean} f The function to call for
 *     for every element. This function takes 3 arguments (the element, the
 *     index and the array) and should return a boolean.
 * @param {S=} opt_obj The object to be used as the value of 'this'
 *     within f.
 * @return {boolean} false if any element fails the test.
 * @template T,S
 */
goog.array.every = goog.NATIVE_ARRAY_PROTOTYPES &&
                   goog.array.ARRAY_PROTOTYPE_.every ?
    function(arr, f, opt_obj) {
      goog.asserts.assert(arr.length != null);

      return goog.array.ARRAY_PROTOTYPE_.every.call(arr, f, opt_obj);
    } :
    function(arr, f, opt_obj) {
      var l = arr.length;  // must be fixed during loop... see docs
      var arr2 = goog.isString(arr) ? arr.split('') : arr;
      for (var i = 0; i < l; i++) {
        if (i in arr2 && !f.call(opt_obj, arr2[i], i, arr)) {
          return false;
        }
      }
      return true;
    };


/**
 * Counts the array elements that fulfill the predicate, i.e. for which the
 * callback function returns true. Skips holes in the array.
 *
 * @param {!(Array.<T>|goog.array.ArrayLike)} arr Array or array like object
 *     over which to iterate.
 * @param {function(this: S, T, number, ?): boolean} f The function to call for
 *     every element. Takes 3 arguments (the element, the index and the array).
 * @param {S=} opt_obj The object to be used as the value of 'this' within f.
 * @return {number} The number of the matching elements.
 * @template T,S
 */
goog.array.count = function(arr, f, opt_obj) {
  var count = 0;
  goog.array.forEach(arr, function(element, index, arr) {
    if (f.call(opt_obj, element, index, arr)) {
      ++count;
    }
  }, opt_obj);
  return count;
};


/**
 * Search an array for the first element that satisfies a given condition and
 * return that element.
 * @param {Array.<T>|goog.array.ArrayLike} arr Array or array
 *     like object over which to iterate.
 * @param {?function(this:S, T, number, ?) : boolean} f The function to call
 *     for every element. This function takes 3 arguments (the element, the
 *     index and the array) and should return a boolean.
 * @param {S=} opt_obj An optional "this" context for the function.
 * @return {T} The first array element that passes the test, or null if no
 *     element is found.
 * @template T,S
 */
goog.array.find = function(arr, f, opt_obj) {
  var i = goog.array.findIndex(arr, f, opt_obj);
  return i < 0 ? null : goog.isString(arr) ? arr.charAt(i) : arr[i];
};


/**
 * Search an array for the first element that satisfies a given condition and
 * return its index.
 * @param {Array.<T>|goog.array.ArrayLike} arr Array or array
 *     like object over which to iterate.
 * @param {?function(this:S, T, number, ?) : boolean} f The function to call for
 *     every element. This function
 *     takes 3 arguments (the element, the index and the array) and should
 *     return a boolean.
 * @param {S=} opt_obj An optional "this" context for the function.
 * @return {number} The index of the first array element that passes the test,
 *     or -1 if no element is found.
 * @template T,S
 */
goog.array.findIndex = function(arr, f, opt_obj) {
  var l = arr.length;  // must be fixed during loop... see docs
  var arr2 = goog.isString(arr) ? arr.split('') : arr;
  for (var i = 0; i < l; i++) {
    if (i in arr2 && f.call(opt_obj, arr2[i], i, arr)) {
      return i;
    }
  }
  return -1;
};


/**
 * Search an array (in reverse order) for the last element that satisfies a
 * given condition and return that element.
 * @param {Array.<T>|goog.array.ArrayLike} arr Array or array
 *     like object over which to iterate.
 * @param {?function(this:S, T, number, ?) : boolean} f The function to call
 *     for every element. This function
 *     takes 3 arguments (the element, the index and the array) and should
 *     return a boolean.
 * @param {S=} opt_obj An optional "this" context for the function.
 * @return {T} The last array element that passes the test, or null if no
 *     element is found.
 * @template T,S
 */
goog.array.findRight = function(arr, f, opt_obj) {
  var i = goog.array.findIndexRight(arr, f, opt_obj);
  return i < 0 ? null : goog.isString(arr) ? arr.charAt(i) : arr[i];
};


/**
 * Search an array (in reverse order) for the last element that satisfies a
 * given condition and return its index.
 * @param {Array.<T>|goog.array.ArrayLike} arr Array or array
 *     like object over which to iterate.
 * @param {?function(this:S, T, number, ?) : boolean} f The function to call
 *     for every element. This function
 *     takes 3 arguments (the element, the index and the array) and should
 *     return a boolean.
 * @param {Object=} opt_obj An optional "this" context for the function.
 * @return {number} The index of the last array element that passes the test,
 *     or -1 if no element is found.
 * @template T,S
 */
goog.array.findIndexRight = function(arr, f, opt_obj) {
  var l = arr.length;  // must be fixed during loop... see docs
  var arr2 = goog.isString(arr) ? arr.split('') : arr;
  for (var i = l - 1; i >= 0; i--) {
    if (i in arr2 && f.call(opt_obj, arr2[i], i, arr)) {
      return i;
    }
  }
  return -1;
};


/**
 * Whether the array contains the given object.
 * @param {goog.array.ArrayLike} arr The array to test for the presence of the
 *     element.
 * @param {*} obj The object for which to test.
 * @return {boolean} true if obj is present.
 */
goog.array.contains = function(arr, obj) {
  return goog.array.indexOf(arr, obj) >= 0;
};


/**
 * Whether the array is empty.
 * @param {goog.array.ArrayLike} arr The array to test.
 * @return {boolean} true if empty.
 */
goog.array.isEmpty = function(arr) {
  return arr.length == 0;
};


/**
 * Clears the array.
 * @param {goog.array.ArrayLike} arr Array or array like object to clear.
 */
goog.array.clear = function(arr) {
  // For non real arrays we don't have the magic length so we delete the
  // indices.
  if (!goog.isArray(arr)) {
    for (var i = arr.length - 1; i >= 0; i--) {
      delete arr[i];
    }
  }
  arr.length = 0;
};


/**
 * Pushes an item into an array, if it's not already in the array.
 * @param {Array.<T>} arr Array into which to insert the item.
 * @param {T} obj Value to add.
 * @template T
 */
goog.array.insert = function(arr, obj) {
  if (!goog.array.contains(arr, obj)) {
    arr.push(obj);
  }
};


/**
 * Inserts an object at the given index of the array.
 * @param {goog.array.ArrayLike} arr The array to modify.
 * @param {*} obj The object to insert.
 * @param {number=} opt_i The index at which to insert the object. If omitted,
 *      treated as 0. A negative index is counted from the end of the array.
 */
goog.array.insertAt = function(arr, obj, opt_i) {
  goog.array.splice(arr, opt_i, 0, obj);
};


/**
 * Inserts at the given index of the array, all elements of another array.
 * @param {goog.array.ArrayLike} arr The array to modify.
 * @param {goog.array.ArrayLike} elementsToAdd The array of elements to add.
 * @param {number=} opt_i The index at which to insert the object. If omitted,
 *      treated as 0. A negative index is counted from the end of the array.
 */
goog.array.insertArrayAt = function(arr, elementsToAdd, opt_i) {
  goog.partial(goog.array.splice, arr, opt_i, 0).apply(null, elementsToAdd);
};


/**
 * Inserts an object into an array before a specified object.
 * @param {Array.<T>} arr The array to modify.
 * @param {T} obj The object to insert.
 * @param {T=} opt_obj2 The object before which obj should be inserted. If obj2
 *     is omitted or not found, obj is inserted at the end of the array.
 * @template T
 */
goog.array.insertBefore = function(arr, obj, opt_obj2) {
  var i;
  if (arguments.length == 2 || (i = goog.array.indexOf(arr, opt_obj2)) < 0) {
    arr.push(obj);
  } else {
    goog.array.insertAt(arr, obj, i);
  }
};


/**
 * Removes the first occurrence of a particular value from an array.
 * @param {goog.array.ArrayLike} arr Array from which to remove value.
 * @param {*} obj Object to remove.
 * @return {boolean} True if an element was removed.
 */
goog.array.remove = function(arr, obj) {
  var i = goog.array.indexOf(arr, obj);
  var rv;
  if ((rv = i >= 0)) {
    goog.array.removeAt(arr, i);
  }
  return rv;
};


/**
 * Removes from an array the element at index i
 * @param {goog.array.ArrayLike} arr Array or array like object from which to
 *     remove value.
 * @param {number} i The index to remove.
 * @return {boolean} True if an element was removed.
 */
goog.array.removeAt = function(arr, i) {
  goog.asserts.assert(arr.length != null);

  // use generic form of splice
  // splice returns the removed items and if successful the length of that
  // will be 1
  return goog.array.ARRAY_PROTOTYPE_.splice.call(arr, i, 1).length == 1;
};


/**
 * Removes the first value that satisfies the given condition.
 * @param {Array.<T>|goog.array.ArrayLike} arr Array or array
 *     like object over which to iterate.
 * @param {?function(this:S, T, number, ?) : boolean} f The function to call
 *     for every element. This function
 *     takes 3 arguments (the element, the index and the array) and should
 *     return a boolean.
 * @param {S=} opt_obj An optional "this" context for the function.
 * @return {boolean} True if an element was removed.
 * @template T,S
 */
goog.array.removeIf = function(arr, f, opt_obj) {
  var i = goog.array.findIndex(arr, f, opt_obj);
  if (i >= 0) {
    goog.array.removeAt(arr, i);
    return true;
  }
  return false;
};


/**
 * Returns a new array that is the result of joining the arguments.  If arrays
 * are passed then their items are added, however, if non-arrays are passed they
 * will be added to the return array as is.
 *
 * Note that ArrayLike objects will be added as is, rather than having their
 * items added.
 *
 * goog.array.concat([1, 2], [3, 4]) -> [1, 2, 3, 4]
 * goog.array.concat(0, [1, 2]) -> [0, 1, 2]
 * goog.array.concat([1, 2], null) -> [1, 2, null]
 *
 * There is bug in all current versions of IE (6, 7 and 8) where arrays created
 * in an iframe become corrupted soon (not immediately) after the iframe is
 * destroyed. This is common if loading data via goog.net.IframeIo, for example.
 * This corruption only affects the concat method which will start throwing
 * Catastrophic Errors (#-2147418113).
 *
 * See http://endoflow.com/scratch/corrupted-arrays.html for a test case.
 *
 * Internally goog.array should use this, so that all methods will continue to
 * work on these broken array objects.
 *
 * @param {...*} var_args Items to concatenate.  Arrays will have each item
 *     added, while primitives and objects will be added as is.
 * @return {!Array} The new resultant array.
 */
goog.array.concat = function(var_args) {
  return goog.array.ARRAY_PROTOTYPE_.concat.apply(
      goog.array.ARRAY_PROTOTYPE_, arguments);
};


/**
 * Converts an object to an array.
 * @param {goog.array.ArrayLike} object  The object to convert to an array.
 * @return {!Array} The object converted into an array. If object has a
 *     length property, every property indexed with a non-negative number
 *     less than length will be included in the result. If object does not
 *     have a length property, an empty array will be returned.
 */
goog.array.toArray = function(object) {
  var length = object.length;

  // If length is not a number the following it false. This case is kept for
  // backwards compatibility since there are callers that pass objects that are
  // not array like.
  if (length > 0) {
    var rv = new Array(length);
    for (var i = 0; i < length; i++) {
      rv[i] = object[i];
    }
    return rv;
  }
  return [];
};


/**
 * Does a shallow copy of an array.
 * @param {goog.array.ArrayLike} arr  Array or array-like object to clone.
 * @return {!Array} Clone of the input array.
 */
goog.array.clone = goog.array.toArray;


/**
 * Extends an array with another array, element, or "array like" object.
 * This function operates 'in-place', it does not create a new Array.
 *
 * Example:
 * var a = [];
 * goog.array.extend(a, [0, 1]);
 * a; // [0, 1]
 * goog.array.extend(a, 2);
 * a; // [0, 1, 2]
 *
 * @param {Array} arr1  The array to modify.
 * @param {...*} var_args The elements or arrays of elements to add to arr1.
 */
goog.array.extend = function(arr1, var_args) {
  for (var i = 1; i < arguments.length; i++) {
    var arr2 = arguments[i];
    // If we have an Array or an Arguments object we can just call push
    // directly.
    var isArrayLike;
    if (goog.isArray(arr2) ||
        // Detect Arguments. ES5 says that the [[Class]] of an Arguments object
        // is "Arguments" but only V8 and JSC/Safari gets this right. We instead
        // detect Arguments by checking for array like and presence of "callee".
        (isArrayLike = goog.isArrayLike(arr2)) &&
            // The getter for callee throws an exception in strict mode
            // according to section 10.6 in ES5 so check for presence instead.
            arr2.hasOwnProperty('callee')) {
      arr1.push.apply(arr1, arr2);

    } else if (isArrayLike) {
      // Otherwise loop over arr2 to prevent copying the object.
      var len1 = arr1.length;
      var len2 = arr2.length;
      for (var j = 0; j < len2; j++) {
        arr1[len1 + j] = arr2[j];
      }
    } else {
      arr1.push(arr2);
    }
  }
};


/**
 * Adds or removes elements from an array. This is a generic version of Array
 * splice. This means that it might work on other objects similar to arrays,
 * such as the arguments object.
 *
 * @param {goog.array.ArrayLike} arr The array to modify.
 * @param {number|undefined} index The index at which to start changing the
 *     array. If not defined, treated as 0.
 * @param {number} howMany How many elements to remove (0 means no removal. A
 *     value below 0 is treated as zero and so is any other non number. Numbers
 *     are floored).
 * @param {...*} var_args Optional, additional elements to insert into the
 *     array.
 * @return {!Array} the removed elements.
 */
goog.array.splice = function(arr, index, howMany, var_args) {
  goog.asserts.assert(arr.length != null);

  return goog.array.ARRAY_PROTOTYPE_.splice.apply(
      arr, goog.array.slice(arguments, 1));
};


/**
 * Returns a new array from a segment of an array. This is a generic version of
 * Array slice. This means that it might work on other objects similar to
 * arrays, such as the arguments object.
 *
 * @param {Array.<T>|goog.array.ArrayLike} arr The array from
 * which to copy a segment.
 * @param {number} start The index of the first element to copy.
 * @param {number=} opt_end The index after the last element to copy.
 * @return {!Array.<T>} A new array containing the specified segment of the
 *     original array.
 * @template T
 */
goog.array.slice = function(arr, start, opt_end) {
  goog.asserts.assert(arr.length != null);

  // passing 1 arg to slice is not the same as passing 2 where the second is
  // null or undefined (in that case the second argument is treated as 0).
  // we could use slice on the arguments object and then use apply instead of
  // testing the length
  if (arguments.length <= 2) {
    return goog.array.ARRAY_PROTOTYPE_.slice.call(arr, start);
  } else {
    return goog.array.ARRAY_PROTOTYPE_.slice.call(arr, start, opt_end);
  }
};


/**
 * Removes all duplicates from an array (retaining only the first
 * occurrence of each array element).  This function modifies the
 * array in place and doesn't change the order of the non-duplicate items.
 *
 * For objects, duplicates are identified as having the same unique ID as
 * defined by {@link goog.getUid}.
 *
 * Runtime: N,
 * Worstcase space: 2N (no dupes)
 *
 * @param {goog.array.ArrayLike} arr The array from which to remove duplicates.
 * @param {Array=} opt_rv An optional array in which to return the results,
 *     instead of performing the removal inplace.  If specified, the original
 *     array will remain unchanged.
 */
goog.array.removeDuplicates = function(arr, opt_rv) {
  var returnArray = opt_rv || arr;

  var seen = {}, cursorInsert = 0, cursorRead = 0;
  while (cursorRead < arr.length) {
    var current = arr[cursorRead++];

    // Prefix each type with a single character representing the type to
    // prevent conflicting keys (e.g. true and 'true').
    var key = goog.isObject(current) ?
        'o' + goog.getUid(current) :
        (typeof current).charAt(0) + current;

    if (!Object.prototype.hasOwnProperty.call(seen, key)) {
      seen[key] = true;
      returnArray[cursorInsert++] = current;
    }
  }
  returnArray.length = cursorInsert;
};


/**
 * Searches the specified array for the specified target using the binary
 * search algorithm.  If no opt_compareFn is specified, elements are compared
 * using <code>goog.array.defaultCompare</code>, which compares the elements
 * using the built in < and > operators.  This will produce the expected
 * behavior for homogeneous arrays of String(s) and Number(s). The array
 * specified <b>must</b> be sorted in ascending order (as defined by the
 * comparison function).  If the array is not sorted, results are undefined.
 * If the array contains multiple instances of the specified target value, any
 * of these instances may be found.
 *
 * Runtime: O(log n)
 *
 * @param {goog.array.ArrayLike} arr The array to be searched.
 * @param {*} target The sought value.
 * @param {Function=} opt_compareFn Optional comparison function by which the
 *     array is ordered. Should take 2 arguments to compare, and return a
 *     negative number, zero, or a positive number depending on whether the
 *     first argument is less than, equal to, or greater than the second.
 * @return {number} Lowest index of the target value if found, otherwise
 *     (-(insertion point) - 1). The insertion point is where the value should
 *     be inserted into arr to preserve the sorted property.  Return value >= 0
 *     iff target is found.
 */
goog.array.binarySearch = function(arr, target, opt_compareFn) {
  return goog.array.binarySearch_(arr,
      opt_compareFn || goog.array.defaultCompare, false /* isEvaluator */,
      target);
};


/**
 * Selects an index in the specified array using the binary search algorithm.
 * The evaluator receives an element and determines whether the desired index
 * is before, at, or after it.  The evaluator must be consistent (formally,
 * goog.array.map(goog.array.map(arr, evaluator, opt_obj), goog.math.sign)
 * must be monotonically non-increasing).
 *
 * Runtime: O(log n)
 *
 * @param {goog.array.ArrayLike} arr The array to be searched.
 * @param {Function} evaluator Evaluator function that receives 3 arguments
 *     (the element, the index and the array). Should return a negative number,
 *     zero, or a positive number depending on whether the desired index is
 *     before, at, or after the element passed to it.
 * @param {Object=} opt_obj The object to be used as the value of 'this'
 *     within evaluator.
 * @return {number} Index of the leftmost element matched by the evaluator, if
 *     such exists; otherwise (-(insertion point) - 1). The insertion point is
 *     the index of the first element for which the evaluator returns negative,
 *     or arr.length if no such element exists. The return value is non-negative
 *     iff a match is found.
 */
goog.array.binarySelect = function(arr, evaluator, opt_obj) {
  return goog.array.binarySearch_(arr, evaluator, true /* isEvaluator */,
      undefined /* opt_target */, opt_obj);
};


/**
 * Implementation of a binary search algorithm which knows how to use both
 * comparison functions and evaluators. If an evaluator is provided, will call
 * the evaluator with the given optional data object, conforming to the
 * interface defined in binarySelect. Otherwise, if a comparison function is
 * provided, will call the comparison function against the given data object.
 *
 * This implementation purposefully does not use goog.bind or goog.partial for
 * performance reasons.
 *
 * Runtime: O(log n)
 *
 * @param {goog.array.ArrayLike} arr The array to be searched.
 * @param {Function} compareFn Either an evaluator or a comparison function,
 *     as defined by binarySearch and binarySelect above.
 * @param {boolean} isEvaluator Whether the function is an evaluator or a
 *     comparison function.
 * @param {*=} opt_target If the function is a comparison function, then this is
 *     the target to binary search for.
 * @param {Object=} opt_selfObj If the function is an evaluator, this is an
  *    optional this object for the evaluator.
 * @return {number} Lowest index of the target value if found, otherwise
 *     (-(insertion point) - 1). The insertion point is where the value should
 *     be inserted into arr to preserve the sorted property.  Return value >= 0
 *     iff target is found.
 * @private
 */
goog.array.binarySearch_ = function(arr, compareFn, isEvaluator, opt_target,
    opt_selfObj) {
  var left = 0;  // inclusive
  var right = arr.length;  // exclusive
  var found;
  while (left < right) {
    var middle = (left + right) >> 1;
    var compareResult;
    if (isEvaluator) {
      compareResult = compareFn.call(opt_selfObj, arr[middle], middle, arr);
    } else {
      compareResult = compareFn(opt_target, arr[middle]);
    }
    if (compareResult > 0) {
      left = middle + 1;
    } else {
      right = middle;
      // We are looking for the lowest index so we can't return immediately.
      found = !compareResult;
    }
  }
  // left is the index if found, or the insertion point otherwise.
  // ~left is a shorthand for -left - 1.
  return found ? left : ~left;
};


/**
 * Sorts the specified array into ascending order.  If no opt_compareFn is
 * specified, elements are compared using
 * <code>goog.array.defaultCompare</code>, which compares the elements using
 * the built in < and > operators.  This will produce the expected behavior
 * for homogeneous arrays of String(s) and Number(s), unlike the native sort,
 * but will give unpredictable results for heterogenous lists of strings and
 * numbers with different numbers of digits.
 *
 * This sort is not guaranteed to be stable.
 *
 * Runtime: Same as <code>Array.prototype.sort</code>
 *
 * @param {Array.<T>} arr The array to be sorted.
 * @param {?function(T,T):number=} opt_compareFn Optional comparison
 *     function by which the
 *     array is to be ordered. Should take 2 arguments to compare, and return a
 *     negative number, zero, or a positive number depending on whether the
 *     first argument is less than, equal to, or greater than the second.
 * @template T
 */
goog.array.sort = function(arr, opt_compareFn) {
  // TODO(arv): Update type annotation since null is not accepted.
  goog.asserts.assert(arr.length != null);

  goog.array.ARRAY_PROTOTYPE_.sort.call(
      arr, opt_compareFn || goog.array.defaultCompare);
};


/**
 * Sorts the specified array into ascending order in a stable way.  If no
 * opt_compareFn is specified, elements are compared using
 * <code>goog.array.defaultCompare</code>, which compares the elements using
 * the built in < and > operators.  This will produce the expected behavior
 * for homogeneous arrays of String(s) and Number(s).
 *
 * Runtime: Same as <code>Array.prototype.sort</code>, plus an additional
 * O(n) overhead of copying the array twice.
 *
 * @param {Array.<T>} arr The array to be sorted.
 * @param {?function(T, T): number=} opt_compareFn Optional comparison function
 *     by which the array is to be ordered. Should take 2 arguments to compare,
 *     and return a negative number, zero, or a positive number depending on
 *     whether the first argument is less than, equal to, or greater than the
 *     second.
 * @template T
 */
goog.array.stableSort = function(arr, opt_compareFn) {
  for (var i = 0; i < arr.length; i++) {
    arr[i] = {index: i, value: arr[i]};
  }
  var valueCompareFn = opt_compareFn || goog.array.defaultCompare;
  function stableCompareFn(obj1, obj2) {
    return valueCompareFn(obj1.value, obj2.value) || obj1.index - obj2.index;
  };
  goog.array.sort(arr, stableCompareFn);
  for (var i = 0; i < arr.length; i++) {
    arr[i] = arr[i].value;
  }
};


/**
 * Sorts an array of objects by the specified object key and compare
 * function. If no compare function is provided, the key values are
 * compared in ascending order using <code>goog.array.defaultCompare</code>.
 * This won't work for keys that get renamed by the compiler. So use
 * {'foo': 1, 'bar': 2} rather than {foo: 1, bar: 2}.
 * @param {Array.<Object>} arr An array of objects to sort.
 * @param {string} key The object key to sort by.
 * @param {Function=} opt_compareFn The function to use to compare key
 *     values.
 */
goog.array.sortObjectsByKey = function(arr, key, opt_compareFn) {
  var compare = opt_compareFn || goog.array.defaultCompare;
  goog.array.sort(arr, function(a, b) {
    return compare(a[key], b[key]);
  });
};


/**
 * Tells if the array is sorted.
 * @param {!Array.<T>} arr The array.
 * @param {?function(T,T):number=} opt_compareFn Function to compare the
 *     array elements.
 *     Should take 2 arguments to compare, and return a negative number, zero,
 *     or a positive number depending on whether the first argument is less
 *     than, equal to, or greater than the second.
 * @param {boolean=} opt_strict If true no equal elements are allowed.
 * @return {boolean} Whether the array is sorted.
 * @template T
 */
goog.array.isSorted = function(arr, opt_compareFn, opt_strict) {
  var compare = opt_compareFn || goog.array.defaultCompare;
  for (var i = 1; i < arr.length; i++) {
    var compareResult = compare(arr[i - 1], arr[i]);
    if (compareResult > 0 || compareResult == 0 && opt_strict) {
      return false;
    }
  }
  return true;
};


/**
 * Compares two arrays for equality. Two arrays are considered equal if they
 * have the same length and their corresponding elements are equal according to
 * the comparison function.
 *
 * @param {goog.array.ArrayLike} arr1 The first array to compare.
 * @param {goog.array.ArrayLike} arr2 The second array to compare.
 * @param {Function=} opt_equalsFn Optional comparison function.
 *     Should take 2 arguments to compare, and return true if the arguments
 *     are equal. Defaults to {@link goog.array.defaultCompareEquality} which
 *     compares the elements using the built-in '===' operator.
 * @return {boolean} Whether the two arrays are equal.
 */
goog.array.equals = function(arr1, arr2, opt_equalsFn) {
  if (!goog.isArrayLike(arr1) || !goog.isArrayLike(arr2) ||
      arr1.length != arr2.length) {
    return false;
  }
  var l = arr1.length;
  var equalsFn = opt_equalsFn || goog.array.defaultCompareEquality;
  for (var i = 0; i < l; i++) {
    if (!equalsFn(arr1[i], arr2[i])) {
      return false;
    }
  }
  return true;
};


/**
 * @deprecated Use {@link goog.array.equals}.
 * @param {goog.array.ArrayLike} arr1 See {@link goog.array.equals}.
 * @param {goog.array.ArrayLike} arr2 See {@link goog.array.equals}.
 * @param {Function=} opt_equalsFn See {@link goog.array.equals}.
 * @return {boolean} See {@link goog.array.equals}.
 */
goog.array.compare = function(arr1, arr2, opt_equalsFn) {
  return goog.array.equals(arr1, arr2, opt_equalsFn);
};


/**
 * 3-way array compare function.
 * @param {!goog.array.ArrayLike} arr1 The first array to compare.
 * @param {!goog.array.ArrayLike} arr2 The second array to compare.
 * @param {?function(?, ?): number=} opt_compareFn Optional comparison function
 *     by which the array is to be ordered. Should take 2 arguments to compare,
 *     and return a negative number, zero, or a positive number depending on
 *     whether the first argument is less than, equal to, or greater than the
 *     second.
 * @return {number} Negative number, zero, or a positive number depending on
 *     whether the first argument is less than, equal to, or greater than the
 *     second.
 */
goog.array.compare3 = function(arr1, arr2, opt_compareFn) {
  var compare = opt_compareFn || goog.array.defaultCompare;
  var l = Math.min(arr1.length, arr2.length);
  for (var i = 0; i < l; i++) {
    var result = compare(arr1[i], arr2[i]);
    if (result != 0) {
      return result;
    }
  }
  return goog.array.defaultCompare(arr1.length, arr2.length);
};


/**
 * Compares its two arguments for order, using the built in < and >
 * operators.
 * @param {*} a The first object to be compared.
 * @param {*} b The second object to be compared.
 * @return {number} A negative number, zero, or a positive number as the first
 *     argument is less than, equal to, or greater than the second.
 */
goog.array.defaultCompare = function(a, b) {
  return a > b ? 1 : a < b ? -1 : 0;
};


/**
 * Compares its two arguments for equality, using the built in === operator.
 * @param {*} a The first object to compare.
 * @param {*} b The second object to compare.
 * @return {boolean} True if the two arguments are equal, false otherwise.
 */
goog.array.defaultCompareEquality = function(a, b) {
  return a === b;
};


/**
 * Inserts a value into a sorted array. The array is not modified if the
 * value is already present.
 * @param {Array.<T>} array The array to modify.
 * @param {T} value The object to insert.
 * @param {?function(T,T):number=} opt_compareFn Optional comparison function by
 *     which the
 *     array is ordered. Should take 2 arguments to compare, and return a
 *     negative number, zero, or a positive number depending on whether the
 *     first argument is less than, equal to, or greater than the second.
 * @return {boolean} True if an element was inserted.
 * @template T
 */
goog.array.binaryInsert = function(array, value, opt_compareFn) {
  var index = goog.array.binarySearch(array, value, opt_compareFn);
  if (index < 0) {
    goog.array.insertAt(array, value, -(index + 1));
    return true;
  }
  return false;
};


/**
 * Removes a value from a sorted array.
 * @param {Array} array The array to modify.
 * @param {*} value The object to remove.
 * @param {Function=} opt_compareFn Optional comparison function by which the
 *     array is ordered. Should take 2 arguments to compare, and return a
 *     negative number, zero, or a positive number depending on whether the
 *     first argument is less than, equal to, or greater than the second.
 * @return {boolean} True if an element was removed.
 */
goog.array.binaryRemove = function(array, value, opt_compareFn) {
  var index = goog.array.binarySearch(array, value, opt_compareFn);
  return (index >= 0) ? goog.array.removeAt(array, index) : false;
};


/**
 * Splits an array into disjoint buckets according to a splitting function.
 * @param {Array.<T>} array The array.
 * @param {function(T,number,Array.<T>):?} sorter Function to call for every
 *     element.  This
 *     takes 3 arguments (the element, the index and the array) and must
 *     return a valid object key (a string, number, etc), or undefined, if
 *     that object should not be placed in a bucket.
 * @return {!Object} An object, with keys being all of the unique return values
 *     of sorter, and values being arrays containing the items for
 *     which the splitter returned that key.
 * @template T
 */
goog.array.bucket = function(array, sorter) {
  var buckets = {};

  for (var i = 0; i < array.length; i++) {
    var value = array[i];
    var key = sorter(value, i, array);
    if (goog.isDef(key)) {
      // Push the value to the right bucket, creating it if necessary.
      var bucket = buckets[key] || (buckets[key] = []);
      bucket.push(value);
    }
  }

  return buckets;
};


/**
 * Creates a new object built from the provided array and the key-generation
 * function.
 * @param {Array.<T>|goog.array.ArrayLike} arr Array or array like object over
 *     which to iterate whose elements will be the values in the new object.
 * @param {?function(this:S, T, number, ?) : string} keyFunc The function to
 *     call for every element. This function takes 3 arguments (the element, the
 *     index and the array) and should return a string that will be used as the
 *     key for the element in the new object. If the function returns the same
 *     key for more than one element, the value for that key is
 *     implementation-defined.
 * @param {S=} opt_obj  The object to be used as the value of 'this'
 *     within keyFunc.
 * @return {!Object.<T>} The new object.
 * @template T,S
 */
goog.array.toObject = function(arr, keyFunc, opt_obj) {
  var ret = {};
  goog.array.forEach(arr, function(element, index) {
    ret[keyFunc.call(opt_obj, element, index, arr)] = element;
  });
  return ret;
};


/**
 * Returns an array consisting of the given value repeated N times.
 *
 * @param {*} value The value to repeat.
 * @param {number} n The repeat count.
 * @return {!Array} An array with the repeated value.
 */
goog.array.repeat = function(value, n) {
  var array = [];
  for (var i = 0; i < n; i++) {
    array[i] = value;
  }
  return array;
};


/**
 * Returns an array consisting of every argument with all arrays
 * expanded in-place recursively.
 *
 * @param {...*} var_args The values to flatten.
 * @return {!Array} An array containing the flattened values.
 */
goog.array.flatten = function(var_args) {
  var result = [];
  for (var i = 0; i < arguments.length; i++) {
    var element = arguments[i];
    if (goog.isArray(element)) {
      result.push.apply(result, goog.array.flatten.apply(null, element));
    } else {
      result.push(element);
    }
  }
  return result;
};


/**
 * Rotates an array in-place. After calling this method, the element at
 * index i will be the element previously at index (i - n) %
 * array.length, for all values of i between 0 and array.length - 1,
 * inclusive.
 *
 * For example, suppose list comprises [t, a, n, k, s]. After invoking
 * rotate(array, 1) (or rotate(array, -4)), array will comprise [s, t, a, n, k].
 *
 * @param {!Array.<T>} array The array to rotate.
 * @param {number} n The amount to rotate.
 * @return {!Array.<T>} The array.
 * @template T
 */
goog.array.rotate = function(array, n) {
  goog.asserts.assert(array.length != null);

  if (array.length) {
    n %= array.length;
    if (n > 0) {
      goog.array.ARRAY_PROTOTYPE_.unshift.apply(array, array.splice(-n, n));
    } else if (n < 0) {
      goog.array.ARRAY_PROTOTYPE_.push.apply(array, array.splice(0, -n));
    }
  }
  return array;
};


/**
 * Creates a new array for which the element at position i is an array of the
 * ith element of the provided arrays.  The returned array will only be as long
 * as the shortest array provided; additional values are ignored.  For example,
 * the result of zipping [1, 2] and [3, 4, 5] is [[1,3], [2, 4]].
 *
 * This is similar to the zip() function in Python.  See {@link
 * http://docs.python.org/library/functions.html#zip}
 *
 * @param {...!goog.array.ArrayLike} var_args Arrays to be combined.
 * @return {!Array.<!Array>} A new array of arrays created from provided arrays.
 */
goog.array.zip = function(var_args) {
  if (!arguments.length) {
    return [];
  }
  var result = [];
  for (var i = 0; true; i++) {
    var value = [];
    for (var j = 0; j < arguments.length; j++) {
      var arr = arguments[j];
      // If i is larger than the array length, this is the shortest array.
      if (i >= arr.length) {
        return result;
      }
      value.push(arr[i]);
    }
    result.push(value);
  }
};


/**
 * Shuffles the values in the specified array using the Fisher-Yates in-place
 * shuffle (also known as the Knuth Shuffle). By default, calls Math.random()
 * and so resets the state of that random number generator. Similarly, may reset
 * the state of the any other specified random number generator.
 *
 * Runtime: O(n)
 *
 * @param {!Array} arr The array to be shuffled.
 * @param {function():number=} opt_randFn Optional random function to use for
 *     shuffling.
 *     Takes no arguments, and returns a random number on the interval [0, 1).
 *     Defaults to Math.random() using JavaScript's built-in Math library.
 */
goog.array.shuffle = function(arr, opt_randFn) {
  var randFn = opt_randFn || Math.random;

  for (var i = arr.length - 1; i > 0; i--) {
    // Choose a random array index in [0, i] (inclusive with i).
    var j = Math.floor(randFn() * (i + 1));

    var tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
};

// Copyright 2008 The Closure Library Authors. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS-IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * @fileoverview Namespace with crypto related helper functions.
 */

goog.provide('goog.crypt');

goog.require('goog.array');


/**
 * Turns a string into an array of bytes; a "byte" being a JS number in the
 * range 0-255.
 * @param {string} str String value to arrify.
 * @return {!Array.<number>} Array of numbers corresponding to the
 *     UCS character codes of each character in str.
 */
goog.crypt.stringToByteArray = function(str) {
  var output = [], p = 0;
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    while (c > 0xff) {
      output[p++] = c & 0xff;
      c >>= 8;
    }
    output[p++] = c;
  }
  return output;
};


/**
 * Turns an array of numbers into the string given by the concatenation of the
 * characters to which the numbers correspond.
 * @param {Array} array Array of numbers representing characters.
 * @return {string} Stringification of the array.
 */
goog.crypt.byteArrayToString = function(array) {
  return String.fromCharCode.apply(null, array);
};


/**
 * Turns an array of numbers into the hex string given by the concatenation of
 * the hex values to which the numbers correspond.
 * @param {Array} array Array of numbers representing characters.
 * @return {string} Hex string.
 */
goog.crypt.byteArrayToHex = function(array) {
  return goog.array.map(array, function(numByte) {
    var hexByte = numByte.toString(16);
    return hexByte.length > 1 ? hexByte : '0' + hexByte;
  }).join('');
};


/**
 * Converts a hex string into an integer array.
 * @param {string} hexString Hex string of 16-bit integers (two characters
 *     per integer).
 * @return {!Array.<number>} Array of {0,255} integers for the given string.
 */
goog.crypt.hexToByteArray = function(hexString) {
  goog.asserts.assert(hexString.length % 2 == 0,
                      'Key string length must be multiple of 2');
  var arr = [];
  for (var i = 0; i < hexString.length; i += 2) {
    arr.push(parseInt(hexString.substring(i, i + 2), 16));
  }
  return arr;
};


/**
 * Converts a JS string to a UTF-8 "byte" array.
 * @param {string} str 16-bit unicode string.
 * @return {Array.<number>} UTF-8 byte array.
 */
goog.crypt.stringToUtf8ByteArray = function(str) {
  // TODO(user): Use native implementations if/when available
  str = str.replace(/\r\n/g, '\n');
  var out = [], p = 0;
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    if (c < 128) {
      out[p++] = c;
    } else if (c < 2048) {
      out[p++] = (c >> 6) | 192;
      out[p++] = (c & 63) | 128;
    } else {
      out[p++] = (c >> 12) | 224;
      out[p++] = ((c >> 6) & 63) | 128;
      out[p++] = (c & 63) | 128;
    }
  }
  return out;
};


/**
 * Converts a UTF-8 byte array to JavaScript's 16-bit Unicode.
 * @param {Array.<number>} bytes UTF-8 byte array.
 * @return {string} 16-bit Unicode string.
 */
goog.crypt.utf8ByteArrayToString = function(bytes) {
  // TODO(user): Use native implementations if/when available
  var out = [], pos = 0, c = 0;
  while (pos < bytes.length) {
    var c1 = bytes[pos++];
    if (c1 < 128) {
      out[c++] = String.fromCharCode(c1);
    } else if (c1 > 191 && c1 < 224) {
      var c2 = bytes[pos++];
      out[c++] = String.fromCharCode((c1 & 31) << 6 | c2 & 63);
    } else {
      var c2 = bytes[pos++];
      var c3 = bytes[pos++];
      out[c++] = String.fromCharCode(
          (c1 & 15) << 12 | (c2 & 63) << 6 | c3 & 63);
    }
  }
  return out.join('');
};


/**
 * XOR two byte arrays.
 * @param {!Array.<number>} bytes1 Byte array 1.
 * @param {!Array.<number>} bytes2 Byte array 2.
 * @return {!Array.<number>} Resulting XOR of the two byte arrays.
 */
goog.crypt.xorByteArray = function(bytes1, bytes2) {
  goog.asserts.assert(
      bytes1.length == bytes2.length,
      'XOR array lengths must match');

  var result = [];
  for (var i = 0; i < bytes1.length; i++) {
    result.push(bytes1[i] ^ bytes2[i]);
  }
  return result;
};

// Copyright 2011 The Closure Library Authors. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS-IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * @fileoverview Abstract cryptographic hash interface.
 *
 * See goog.crypt.Sha1 and goog.crypt.Md5 for sample implementations.
 *
 */

goog.provide('goog.crypt.Hash');



/**
 * Create a cryptographic hash instance.
 *
 * @constructor
 */
goog.crypt.Hash = function() {};


/**
 * Resets the internal accumulator.
 */
goog.crypt.Hash.prototype.reset = goog.abstractMethod;


/**
 * Adds a byte array (array with values in [0-255] range) or a string (might
 * only contain 8-bit, i.e., Latin1 characters) to the internal accumulator.
 *
 * Many hash functions operate on blocks of data and implement optimizations
 * when a full chunk of data is readily available. Hence it is often preferable
 * to provide large chunks of data (a kilobyte or more) than to repeatedly
 * call the update method with few tens of bytes. If this is not possible, or
 * not feasible, it might be good to provide data in multiplies of hash block
 * size (often 64 bytes). Please see the implementation and performance tests
 * of your favourite hash.
 *
 * @param {Array.<number>|Uint8Array|string} bytes Data used for the update.
 * @param {number=} opt_length Number of bytes to use.
 */
goog.crypt.Hash.prototype.update = goog.abstractMethod;


/**
 * @return {!Array.<number>} The finalized hash computed
 *     from the internal accumulator.
 */
goog.crypt.Hash.prototype.digest = goog.abstractMethod;

// Copyright 2011 The Closure Library Authors. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS-IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * @fileoverview MD5 cryptographic hash.
 * Implementation of http://tools.ietf.org/html/rfc1321 with common
 * optimizations and tweaks (see http://en.wikipedia.org/wiki/MD5).
 *
 * Usage:
 *   var md5 = new goog.crypt.Md5();
 *   md5.update(bytes);
 *   var hash = md5.digest();
 *
 * Performance:
 *   Chrome 23              ~680 Mbit/s
 *   Chrome 13 (in a VM)    ~250 Mbit/s
 *   Firefox 6.0 (in a VM)  ~100 Mbit/s
 *   IE9 (in a VM)           ~27 Mbit/s
 *   Firefox 3.6             ~15 Mbit/s
 *   IE8 (in a VM)           ~13 Mbit/s
 *
 */

goog.provide('goog.crypt.Md5');

goog.require('goog.crypt.Hash');



/**
 * MD5 cryptographic hash constructor.
 * @constructor
 * @extends {goog.crypt.Hash}
 */
goog.crypt.Md5 = function() {
  goog.base(this);

  /**
   * Holds the current values of accumulated A-D variables (MD buffer).
   * @type {Array.<number>}
   * @private
   */
  this.chain_ = new Array(4);

  /**
   * A buffer holding the data until the whole block can be processed.
   * @type {Array.<number>}
   * @private
   */
  this.block_ = new Array(64);

  /**
   * The length of yet-unprocessed data as collected in the block.
   * @type {number}
   * @private
   */
  this.blockLength_ = 0;

  /**
   * The total length of the message so far.
   * @type {number}
   * @private
   */
  this.totalLength_ = 0;

  this.reset();
};
goog.inherits(goog.crypt.Md5, goog.crypt.Hash);


/**
 * Integer rotation constants used by the abbreviated implementation.
 * They are hardcoded in the unrolled implementation, so it is left
 * here commented out.
 * @type {Array.<number>}
 * @private
 *
goog.crypt.Md5.S_ = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
];
 */

/**
 * Sine function constants used by the abbreviated implementation.
 * They are hardcoded in the unrolled implementation, so it is left
 * here commented out.
 * @type {Array.<number>}
 * @private
 *
goog.crypt.Md5.T_ = [
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee,
  0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
  0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa,
  0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed,
  0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
  0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05,
  0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039,
  0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
  0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391
];
 */


/** @override */
goog.crypt.Md5.prototype.reset = function() {
  this.chain_[0] = 0x67452301;
  this.chain_[1] = 0xefcdab89;
  this.chain_[2] = 0x98badcfe;
  this.chain_[3] = 0x10325476;

  this.blockLength_ = 0;
  this.totalLength_ = 0;
};


/**
 * Internal compress helper function. It takes a block of data (64 bytes)
 * and updates the accumulator.
 * @param {Array.<number>|Uint8Array|string} buf The block to compress.
 * @param {number=} opt_offset Offset of the block in the buffer.
 * @private
 */
goog.crypt.Md5.prototype.compress_ = function(buf, opt_offset) {
  if (!opt_offset) {
    opt_offset = 0;
  }

  // We allocate the array every time, but it's cheap in practice.
  var X = new Array(16);

  // Get 16 little endian words. It is not worth unrolling this for Chrome 11.
  if (goog.isString(buf)) {
    for (var i = 0; i < 16; ++i) {
      X[i] = (buf.charCodeAt(opt_offset++)) |
             (buf.charCodeAt(opt_offset++) << 8) |
             (buf.charCodeAt(opt_offset++) << 16) |
             (buf.charCodeAt(opt_offset++) << 24);
    }
  } else {
    for (var i = 0; i < 16; ++i) {
      X[i] = (buf[opt_offset++]) |
             (buf[opt_offset++] << 8) |
             (buf[opt_offset++] << 16) |
             (buf[opt_offset++] << 24);
    }
  }

  var A = this.chain_[0];
  var B = this.chain_[1];
  var C = this.chain_[2];
  var D = this.chain_[3];
  var sum = 0;

  /*
   * This is an abbreviated implementation, it is left here commented out for
   * reference purposes. See below for an unrolled version in use.
   *
  var f, n, tmp;
  for (var i = 0; i < 64; ++i) {

    if (i < 16) {
      f = (D ^ (B & (C ^ D)));
      n = i;
    } else if (i < 32) {
      f = (C ^ (D & (B ^ C)));
      n = (5 * i + 1) % 16;
    } else if (i < 48) {
      f = (B ^ C ^ D);
      n = (3 * i + 5) % 16;
    } else {
      f = (C ^ (B | (~D)));
      n = (7 * i) % 16;
    }

    tmp = D;
    D = C;
    C = B;
    sum = (A + f + goog.crypt.Md5.T_[i] + X[n]) & 0xffffffff;
    B += ((sum << goog.crypt.Md5.S_[i]) & 0xffffffff) |
         (sum >>> (32 - goog.crypt.Md5.S_[i]));
    A = tmp;
  }
   */

  /*
   * This is an unrolled MD5 implementation, which gives ~30% speedup compared
   * to the abbreviated implementation above, as measured on Chrome 11. It is
   * important to keep 32-bit croppings to minimum and inline the integer
   * rotation.
   */
  sum = (A + (D ^ (B & (C ^ D))) + X[0] + 0xd76aa478) & 0xffffffff;
  A = B + (((sum << 7) & 0xffffffff) | (sum >>> 25));
  sum = (D + (C ^ (A & (B ^ C))) + X[1] + 0xe8c7b756) & 0xffffffff;
  D = A + (((sum << 12) & 0xffffffff) | (sum >>> 20));
  sum = (C + (B ^ (D & (A ^ B))) + X[2] + 0x242070db) & 0xffffffff;
  C = D + (((sum << 17) & 0xffffffff) | (sum >>> 15));
  sum = (B + (A ^ (C & (D ^ A))) + X[3] + 0xc1bdceee) & 0xffffffff;
  B = C + (((sum << 22) & 0xffffffff) | (sum >>> 10));
  sum = (A + (D ^ (B & (C ^ D))) + X[4] + 0xf57c0faf) & 0xffffffff;
  A = B + (((sum << 7) & 0xffffffff) | (sum >>> 25));
  sum = (D + (C ^ (A & (B ^ C))) + X[5] + 0x4787c62a) & 0xffffffff;
  D = A + (((sum << 12) & 0xffffffff) | (sum >>> 20));
  sum = (C + (B ^ (D & (A ^ B))) + X[6] + 0xa8304613) & 0xffffffff;
  C = D + (((sum << 17) & 0xffffffff) | (sum >>> 15));
  sum = (B + (A ^ (C & (D ^ A))) + X[7] + 0xfd469501) & 0xffffffff;
  B = C + (((sum << 22) & 0xffffffff) | (sum >>> 10));
  sum = (A + (D ^ (B & (C ^ D))) + X[8] + 0x698098d8) & 0xffffffff;
  A = B + (((sum << 7) & 0xffffffff) | (sum >>> 25));
  sum = (D + (C ^ (A & (B ^ C))) + X[9] + 0x8b44f7af) & 0xffffffff;
  D = A + (((sum << 12) & 0xffffffff) | (sum >>> 20));
  sum = (C + (B ^ (D & (A ^ B))) + X[10] + 0xffff5bb1) & 0xffffffff;
  C = D + (((sum << 17) & 0xffffffff) | (sum >>> 15));
  sum = (B + (A ^ (C & (D ^ A))) + X[11] + 0x895cd7be) & 0xffffffff;
  B = C + (((sum << 22) & 0xffffffff) | (sum >>> 10));
  sum = (A + (D ^ (B & (C ^ D))) + X[12] + 0x6b901122) & 0xffffffff;
  A = B + (((sum << 7) & 0xffffffff) | (sum >>> 25));
  sum = (D + (C ^ (A & (B ^ C))) + X[13] + 0xfd987193) & 0xffffffff;
  D = A + (((sum << 12) & 0xffffffff) | (sum >>> 20));
  sum = (C + (B ^ (D & (A ^ B))) + X[14] + 0xa679438e) & 0xffffffff;
  C = D + (((sum << 17) & 0xffffffff) | (sum >>> 15));
  sum = (B + (A ^ (C & (D ^ A))) + X[15] + 0x49b40821) & 0xffffffff;
  B = C + (((sum << 22) & 0xffffffff) | (sum >>> 10));
  sum = (A + (C ^ (D & (B ^ C))) + X[1] + 0xf61e2562) & 0xffffffff;
  A = B + (((sum << 5) & 0xffffffff) | (sum >>> 27));
  sum = (D + (B ^ (C & (A ^ B))) + X[6] + 0xc040b340) & 0xffffffff;
  D = A + (((sum << 9) & 0xffffffff) | (sum >>> 23));
  sum = (C + (A ^ (B & (D ^ A))) + X[11] + 0x265e5a51) & 0xffffffff;
  C = D + (((sum << 14) & 0xffffffff) | (sum >>> 18));
  sum = (B + (D ^ (A & (C ^ D))) + X[0] + 0xe9b6c7aa) & 0xffffffff;
  B = C + (((sum << 20) & 0xffffffff) | (sum >>> 12));
  sum = (A + (C ^ (D & (B ^ C))) + X[5] + 0xd62f105d) & 0xffffffff;
  A = B + (((sum << 5) & 0xffffffff) | (sum >>> 27));
  sum = (D + (B ^ (C & (A ^ B))) + X[10] + 0x02441453) & 0xffffffff;
  D = A + (((sum << 9) & 0xffffffff) | (sum >>> 23));
  sum = (C + (A ^ (B & (D ^ A))) + X[15] + 0xd8a1e681) & 0xffffffff;
  C = D + (((sum << 14) & 0xffffffff) | (sum >>> 18));
  sum = (B + (D ^ (A & (C ^ D))) + X[4] + 0xe7d3fbc8) & 0xffffffff;
  B = C + (((sum << 20) & 0xffffffff) | (sum >>> 12));
  sum = (A + (C ^ (D & (B ^ C))) + X[9] + 0x21e1cde6) & 0xffffffff;
  A = B + (((sum << 5) & 0xffffffff) | (sum >>> 27));
  sum = (D + (B ^ (C & (A ^ B))) + X[14] + 0xc33707d6) & 0xffffffff;
  D = A + (((sum << 9) & 0xffffffff) | (sum >>> 23));
  sum = (C + (A ^ (B & (D ^ A))) + X[3] + 0xf4d50d87) & 0xffffffff;
  C = D + (((sum << 14) & 0xffffffff) | (sum >>> 18));
  sum = (B + (D ^ (A & (C ^ D))) + X[8] + 0x455a14ed) & 0xffffffff;
  B = C + (((sum << 20) & 0xffffffff) | (sum >>> 12));
  sum = (A + (C ^ (D & (B ^ C))) + X[13] + 0xa9e3e905) & 0xffffffff;
  A = B + (((sum << 5) & 0xffffffff) | (sum >>> 27));
  sum = (D + (B ^ (C & (A ^ B))) + X[2] + 0xfcefa3f8) & 0xffffffff;
  D = A + (((sum << 9) & 0xffffffff) | (sum >>> 23));
  sum = (C + (A ^ (B & (D ^ A))) + X[7] + 0x676f02d9) & 0xffffffff;
  C = D + (((sum << 14) & 0xffffffff) | (sum >>> 18));
  sum = (B + (D ^ (A & (C ^ D))) + X[12] + 0x8d2a4c8a) & 0xffffffff;
  B = C + (((sum << 20) & 0xffffffff) | (sum >>> 12));
  sum = (A + (B ^ C ^ D) + X[5] + 0xfffa3942) & 0xffffffff;
  A = B + (((sum << 4) & 0xffffffff) | (sum >>> 28));
  sum = (D + (A ^ B ^ C) + X[8] + 0x8771f681) & 0xffffffff;
  D = A + (((sum << 11) & 0xffffffff) | (sum >>> 21));
  sum = (C + (D ^ A ^ B) + X[11] + 0x6d9d6122) & 0xffffffff;
  C = D + (((sum << 16) & 0xffffffff) | (sum >>> 16));
  sum = (B + (C ^ D ^ A) + X[14] + 0xfde5380c) & 0xffffffff;
  B = C + (((sum << 23) & 0xffffffff) | (sum >>> 9));
  sum = (A + (B ^ C ^ D) + X[1] + 0xa4beea44) & 0xffffffff;
  A = B + (((sum << 4) & 0xffffffff) | (sum >>> 28));
  sum = (D + (A ^ B ^ C) + X[4] + 0x4bdecfa9) & 0xffffffff;
  D = A + (((sum << 11) & 0xffffffff) | (sum >>> 21));
  sum = (C + (D ^ A ^ B) + X[7] + 0xf6bb4b60) & 0xffffffff;
  C = D + (((sum << 16) & 0xffffffff) | (sum >>> 16));
  sum = (B + (C ^ D ^ A) + X[10] + 0xbebfbc70) & 0xffffffff;
  B = C + (((sum << 23) & 0xffffffff) | (sum >>> 9));
  sum = (A + (B ^ C ^ D) + X[13] + 0x289b7ec6) & 0xffffffff;
  A = B + (((sum << 4) & 0xffffffff) | (sum >>> 28));
  sum = (D + (A ^ B ^ C) + X[0] + 0xeaa127fa) & 0xffffffff;
  D = A + (((sum << 11) & 0xffffffff) | (sum >>> 21));
  sum = (C + (D ^ A ^ B) + X[3] + 0xd4ef3085) & 0xffffffff;
  C = D + (((sum << 16) & 0xffffffff) | (sum >>> 16));
  sum = (B + (C ^ D ^ A) + X[6] + 0x04881d05) & 0xffffffff;
  B = C + (((sum << 23) & 0xffffffff) | (sum >>> 9));
  sum = (A + (B ^ C ^ D) + X[9] + 0xd9d4d039) & 0xffffffff;
  A = B + (((sum << 4) & 0xffffffff) | (sum >>> 28));
  sum = (D + (A ^ B ^ C) + X[12] + 0xe6db99e5) & 0xffffffff;
  D = A + (((sum << 11) & 0xffffffff) | (sum >>> 21));
  sum = (C + (D ^ A ^ B) + X[15] + 0x1fa27cf8) & 0xffffffff;
  C = D + (((sum << 16) & 0xffffffff) | (sum >>> 16));
  sum = (B + (C ^ D ^ A) + X[2] + 0xc4ac5665) & 0xffffffff;
  B = C + (((sum << 23) & 0xffffffff) | (sum >>> 9));
  sum = (A + (C ^ (B | (~D))) + X[0] + 0xf4292244) & 0xffffffff;
  A = B + (((sum << 6) & 0xffffffff) | (sum >>> 26));
  sum = (D + (B ^ (A | (~C))) + X[7] + 0x432aff97) & 0xffffffff;
  D = A + (((sum << 10) & 0xffffffff) | (sum >>> 22));
  sum = (C + (A ^ (D | (~B))) + X[14] + 0xab9423a7) & 0xffffffff;
  C = D + (((sum << 15) & 0xffffffff) | (sum >>> 17));
  sum = (B + (D ^ (C | (~A))) + X[5] + 0xfc93a039) & 0xffffffff;
  B = C + (((sum << 21) & 0xffffffff) | (sum >>> 11));
  sum = (A + (C ^ (B | (~D))) + X[12] + 0x655b59c3) & 0xffffffff;
  A = B + (((sum << 6) & 0xffffffff) | (sum >>> 26));
  sum = (D + (B ^ (A | (~C))) + X[3] + 0x8f0ccc92) & 0xffffffff;
  D = A + (((sum << 10) & 0xffffffff) | (sum >>> 22));
  sum = (C + (A ^ (D | (~B))) + X[10] + 0xffeff47d) & 0xffffffff;
  C = D + (((sum << 15) & 0xffffffff) | (sum >>> 17));
  sum = (B + (D ^ (C | (~A))) + X[1] + 0x85845dd1) & 0xffffffff;
  B = C + (((sum << 21) & 0xffffffff) | (sum >>> 11));
  sum = (A + (C ^ (B | (~D))) + X[8] + 0x6fa87e4f) & 0xffffffff;
  A = B + (((sum << 6) & 0xffffffff) | (sum >>> 26));
  sum = (D + (B ^ (A | (~C))) + X[15] + 0xfe2ce6e0) & 0xffffffff;
  D = A + (((sum << 10) & 0xffffffff) | (sum >>> 22));
  sum = (C + (A ^ (D | (~B))) + X[6] + 0xa3014314) & 0xffffffff;
  C = D + (((sum << 15) & 0xffffffff) | (sum >>> 17));
  sum = (B + (D ^ (C | (~A))) + X[13] + 0x4e0811a1) & 0xffffffff;
  B = C + (((sum << 21) & 0xffffffff) | (sum >>> 11));
  sum = (A + (C ^ (B | (~D))) + X[4] + 0xf7537e82) & 0xffffffff;
  A = B + (((sum << 6) & 0xffffffff) | (sum >>> 26));
  sum = (D + (B ^ (A | (~C))) + X[11] + 0xbd3af235) & 0xffffffff;
  D = A + (((sum << 10) & 0xffffffff) | (sum >>> 22));
  sum = (C + (A ^ (D | (~B))) + X[2] + 0x2ad7d2bb) & 0xffffffff;
  C = D + (((sum << 15) & 0xffffffff) | (sum >>> 17));
  sum = (B + (D ^ (C | (~A))) + X[9] + 0xeb86d391) & 0xffffffff;
  B = C + (((sum << 21) & 0xffffffff) | (sum >>> 11));

  this.chain_[0] = (this.chain_[0] + A) & 0xffffffff;
  this.chain_[1] = (this.chain_[1] + B) & 0xffffffff;
  this.chain_[2] = (this.chain_[2] + C) & 0xffffffff;
  this.chain_[3] = (this.chain_[3] + D) & 0xffffffff;
};


/** @override */
goog.crypt.Md5.prototype.update = function(bytes, opt_length) {
  if (!goog.isDef(opt_length)) {
    opt_length = bytes.length;
  }
  var lengthMinusBlock = opt_length - 64;

  // Copy some object properties to local variables in order to save on access
  // time from inside the loop (~10% speedup was observed on Chrome 11).
  var block = this.block_;
  var blockLength = this.blockLength_;
  var i = 0;

  // The outer while loop should execute at most twice.
  while (i < opt_length) {
    // When we have no data in the block to top up, we can directly process the
    // input buffer (assuming it contains sufficient data). This gives ~30%
    // speedup on Chrome 14 and ~70% speedup on Firefox 6.0, but requires that
    // the data is provided in large chunks (or in multiples of 64 bytes).
    if (blockLength == 0) {
      while (i <= lengthMinusBlock) {
        this.compress_(bytes, i);
        i += 64;
      }
    }

    if (goog.isString(bytes)) {
      while (i < opt_length) {
        block[blockLength++] = bytes.charCodeAt(i++);
        if (blockLength == 64) {
          this.compress_(block);
          blockLength = 0;
          // Jump to the outer loop so we use the full-block optimization.
          break;
        }
      }
    } else {
      while (i < opt_length) {
        block[blockLength++] = bytes[i++];
        if (blockLength == 64) {
          this.compress_(block);
          blockLength = 0;
          // Jump to the outer loop so we use the full-block optimization.
          break;
        }
      }
    }
  }

  this.blockLength_ = blockLength;
  this.totalLength_ += opt_length;
};


/** @override */
goog.crypt.Md5.prototype.digest = function() {
  // This must accommodate at least 1 padding byte (0x80), 8 bytes of
  // total bitlength, and must end at a 64-byte boundary.
  var pad = new Array((this.blockLength_ < 56 ? 64 : 128) - this.blockLength_);

  // Add padding: 0x80 0x00*
  pad[0] = 0x80;
  for (var i = 1; i < pad.length - 8; ++i) {
    pad[i] = 0;
  }
  // Add the total number of bits, little endian 64-bit integer.
  var totalBits = this.totalLength_ * 8;
  for (var i = pad.length - 8; i < pad.length; ++i) {
    pad[i] = totalBits & 0xff;
    totalBits /= 0x100; // Don't use bit-shifting here!
  }
  this.update(pad);

  var digest = new Array(16);
  var n = 0;
  for (var i = 0; i < 4; ++i) {
    for (var j = 0; j < 32; j += 8) {
      digest[n++] = (this.chain_[i] >>> j) & 0xff;
    }
  }
  return digest;
};

// Copyright 2009 The Closure Library Authors. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS-IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * @fileoverview Defines a Long class for representing a 64-bit two's-complement
 * integer value, which faithfully simulates the behavior of a Java "long". This
 * implementation is derived from LongLib in GWT.
 *
 */

goog.provide('goog.math.Long');



/**
 * Constructs a 64-bit two's-complement integer, given its low and high 32-bit
 * values as *signed* integers.  See the from* functions below for more
 * convenient ways of constructing Longs.
 *
 * The internal representation of a long is the two given signed, 32-bit values.
 * We use 32-bit pieces because these are the size of integers on which
 * Javascript performs bit-operations.  For operations like addition and
 * multiplication, we split each number into 16-bit pieces, which can easily be
 * multiplied within Javascript's floating-point representation without overflow
 * or change in sign.
 *
 * In the algorithms below, we frequently reduce the negative case to the
 * positive case by negating the input(s) and then post-processing the result.
 * Note that we must ALWAYS check specially whether those values are MIN_VALUE
 * (-2^63) because -MIN_VALUE == MIN_VALUE (since 2^63 cannot be represented as
 * a positive number, it overflows back into a negative).  Not handling this
 * case would often result in infinite recursion.
 *
 * @param {number} low  The low (signed) 32 bits of the long.
 * @param {number} high  The high (signed) 32 bits of the long.
 * @constructor
 */
goog.math.Long = function(low, high) {
  /**
   * @type {number}
   * @private
   */
  this.low_ = low | 0;  // force into 32 signed bits.

  /**
   * @type {number}
   * @private
   */
  this.high_ = high | 0;  // force into 32 signed bits.
};


// NOTE: Common constant values ZERO, ONE, NEG_ONE, etc. are defined below the
// from* methods on which they depend.


/**
 * A cache of the Long representations of small integer values.
 * @type {!Object}
 * @private
 */
goog.math.Long.IntCache_ = {};


/**
 * Returns a Long representing the given (32-bit) integer value.
 * @param {number} value The 32-bit integer in question.
 * @return {!goog.math.Long} The corresponding Long value.
 */
goog.math.Long.fromInt = function(value) {
  if (-128 <= value && value < 128) {
    var cachedObj = goog.math.Long.IntCache_[value];
    if (cachedObj) {
      return cachedObj;
    }
  }

  var obj = new goog.math.Long(value | 0, value < 0 ? -1 : 0);
  if (-128 <= value && value < 128) {
    goog.math.Long.IntCache_[value] = obj;
  }
  return obj;
};


/**
 * Returns a Long representing the given value, provided that it is a finite
 * number.  Otherwise, zero is returned.
 * @param {number} value The number in question.
 * @return {!goog.math.Long} The corresponding Long value.
 */
goog.math.Long.fromNumber = function(value) {
  if (isNaN(value) || !isFinite(value)) {
    return goog.math.Long.ZERO;
  } else if (value <= -goog.math.Long.TWO_PWR_63_DBL_) {
    return goog.math.Long.MIN_VALUE;
  } else if (value + 1 >= goog.math.Long.TWO_PWR_63_DBL_) {
    return goog.math.Long.MAX_VALUE;
  } else if (value < 0) {
    return goog.math.Long.fromNumber(-value).negate();
  } else {
    return new goog.math.Long(
        (value % goog.math.Long.TWO_PWR_32_DBL_) | 0,
        (value / goog.math.Long.TWO_PWR_32_DBL_) | 0);
  }
};


/**
 * Returns a Long representing the 64-bit integer that comes by concatenating
 * the given high and low bits.  Each is assumed to use 32 bits.
 * @param {number} lowBits The low 32-bits.
 * @param {number} highBits The high 32-bits.
 * @return {!goog.math.Long} The corresponding Long value.
 */
goog.math.Long.fromBits = function(lowBits, highBits) {
  return new goog.math.Long(lowBits, highBits);
};


/**
 * Returns a Long representation of the given string, written using the given
 * radix.
 * @param {string} str The textual representation of the Long.
 * @param {number=} opt_radix The radix in which the text is written.
 * @return {!goog.math.Long} The corresponding Long value.
 */
goog.math.Long.fromString = function(str, opt_radix) {
  if (str.length == 0) {
    throw Error('number format error: empty string');
  }

  var radix = opt_radix || 10;
  if (radix < 2 || 36 < radix) {
    throw Error('radix out of range: ' + radix);
  }

  if (str.charAt(0) == '-') {
    return goog.math.Long.fromString(str.substring(1), radix).negate();
  } else if (str.indexOf('-') >= 0) {
    throw Error('number format error: interior "-" character: ' + str);
  }

  // Do several (8) digits each time through the loop, so as to
  // minimize the calls to the very expensive emulated div.
  var radixToPower = goog.math.Long.fromNumber(Math.pow(radix, 8));

  var result = goog.math.Long.ZERO;
  for (var i = 0; i < str.length; i += 8) {
    var size = Math.min(8, str.length - i);
    var value = parseInt(str.substring(i, i + size), radix);
    if (size < 8) {
      var power = goog.math.Long.fromNumber(Math.pow(radix, size));
      result = result.multiply(power).add(goog.math.Long.fromNumber(value));
    } else {
      result = result.multiply(radixToPower);
      result = result.add(goog.math.Long.fromNumber(value));
    }
  }
  return result;
};


// NOTE: the compiler should inline these constant values below and then remove
// these variables, so there should be no runtime penalty for these.


/**
 * Number used repeated below in calculations.  This must appear before the
 * first call to any from* function below.
 * @type {number}
 * @private
 */
goog.math.Long.TWO_PWR_16_DBL_ = 1 << 16;


/**
 * @type {number}
 * @private
 */
goog.math.Long.TWO_PWR_24_DBL_ = 1 << 24;


/**
 * @type {number}
 * @private
 */
goog.math.Long.TWO_PWR_32_DBL_ =
    goog.math.Long.TWO_PWR_16_DBL_ * goog.math.Long.TWO_PWR_16_DBL_;


/**
 * @type {number}
 * @private
 */
goog.math.Long.TWO_PWR_31_DBL_ =
    goog.math.Long.TWO_PWR_32_DBL_ / 2;


/**
 * @type {number}
 * @private
 */
goog.math.Long.TWO_PWR_48_DBL_ =
    goog.math.Long.TWO_PWR_32_DBL_ * goog.math.Long.TWO_PWR_16_DBL_;


/**
 * @type {number}
 * @private
 */
goog.math.Long.TWO_PWR_64_DBL_ =
    goog.math.Long.TWO_PWR_32_DBL_ * goog.math.Long.TWO_PWR_32_DBL_;


/**
 * @type {number}
 * @private
 */
goog.math.Long.TWO_PWR_63_DBL_ =
    goog.math.Long.TWO_PWR_64_DBL_ / 2;


/** @type {!goog.math.Long} */
goog.math.Long.ZERO = goog.math.Long.fromInt(0);


/** @type {!goog.math.Long} */
goog.math.Long.ONE = goog.math.Long.fromInt(1);


/** @type {!goog.math.Long} */
goog.math.Long.NEG_ONE = goog.math.Long.fromInt(-1);


/** @type {!goog.math.Long} */
goog.math.Long.MAX_VALUE =
    goog.math.Long.fromBits(0xFFFFFFFF | 0, 0x7FFFFFFF | 0);


/** @type {!goog.math.Long} */
goog.math.Long.MIN_VALUE = goog.math.Long.fromBits(0, 0x80000000 | 0);


/**
 * @type {!goog.math.Long}
 * @private
 */
goog.math.Long.TWO_PWR_24_ = goog.math.Long.fromInt(1 << 24);


/** @return {number} The value, assuming it is a 32-bit integer. */
goog.math.Long.prototype.toInt = function() {
  return this.low_;
};


/** @return {number} The closest floating-point representation to this value. */
goog.math.Long.prototype.toNumber = function() {
  return this.high_ * goog.math.Long.TWO_PWR_32_DBL_ +
         this.getLowBitsUnsigned();
};


/**
 * @param {number=} opt_radix The radix in which the text should be written.
 * @return {string} The textual representation of this value.
 * @override
 */
goog.math.Long.prototype.toString = function(opt_radix) {
  var radix = opt_radix || 10;
  if (radix < 2 || 36 < radix) {
    throw Error('radix out of range: ' + radix);
  }

  if (this.isZero()) {
    return '0';
  }

  if (this.isNegative()) {
    if (this.equals(goog.math.Long.MIN_VALUE)) {
      // We need to change the Long value before it can be negated, so we remove
      // the bottom-most digit in this base and then recurse to do the rest.
      var radixLong = goog.math.Long.fromNumber(radix);
      var div = this.div(radixLong);
      var rem = div.multiply(radixLong).subtract(this);
      return div.toString(radix) + rem.toInt().toString(radix);
    } else {
      return '-' + this.negate().toString(radix);
    }
  }

  // Do several (6) digits each time through the loop, so as to
  // minimize the calls to the very expensive emulated div.
  var radixToPower = goog.math.Long.fromNumber(Math.pow(radix, 6));

  var rem = this;
  var result = '';
  while (true) {
    var remDiv = rem.div(radixToPower);
    var intval = rem.subtract(remDiv.multiply(radixToPower)).toInt();
    var digits = intval.toString(radix);

    rem = remDiv;
    if (rem.isZero()) {
      return digits + result;
    } else {
      while (digits.length < 6) {
        digits = '0' + digits;
      }
      result = '' + digits + result;
    }
  }
};


/** @return {number} The high 32-bits as a signed value. */
goog.math.Long.prototype.getHighBits = function() {
  return this.high_;
};


/** @return {number} The low 32-bits as a signed value. */
goog.math.Long.prototype.getLowBits = function() {
  return this.low_;
};


/** @return {number} The low 32-bits as an unsigned value. */
goog.math.Long.prototype.getLowBitsUnsigned = function() {
  return (this.low_ >= 0) ?
      this.low_ : goog.math.Long.TWO_PWR_32_DBL_ + this.low_;
};


/**
 * @return {number} Returns the number of bits needed to represent the absolute
 *     value of this Long.
 */
goog.math.Long.prototype.getNumBitsAbs = function() {
  if (this.isNegative()) {
    if (this.equals(goog.math.Long.MIN_VALUE)) {
      return 64;
    } else {
      return this.negate().getNumBitsAbs();
    }
  } else {
    var val = this.high_ != 0 ? this.high_ : this.low_;
    for (var bit = 31; bit > 0; bit--) {
      if ((val & (1 << bit)) != 0) {
        break;
      }
    }
    return this.high_ != 0 ? bit + 33 : bit + 1;
  }
};


/** @return {boolean} Whether this value is zero. */
goog.math.Long.prototype.isZero = function() {
  return this.high_ == 0 && this.low_ == 0;
};


/** @return {boolean} Whether this value is negative. */
goog.math.Long.prototype.isNegative = function() {
  return this.high_ < 0;
};


/** @return {boolean} Whether this value is odd. */
goog.math.Long.prototype.isOdd = function() {
  return (this.low_ & 1) == 1;
};


/**
 * @param {goog.math.Long} other Long to compare against.
 * @return {boolean} Whether this Long equals the other.
 */
goog.math.Long.prototype.equals = function(other) {
  return (this.high_ == other.high_) && (this.low_ == other.low_);
};


/**
 * @param {goog.math.Long} other Long to compare against.
 * @return {boolean} Whether this Long does not equal the other.
 */
goog.math.Long.prototype.notEquals = function(other) {
  return (this.high_ != other.high_) || (this.low_ != other.low_);
};


/**
 * @param {goog.math.Long} other Long to compare against.
 * @return {boolean} Whether this Long is less than the other.
 */
goog.math.Long.prototype.lessThan = function(other) {
  return this.compare(other) < 0;
};


/**
 * @param {goog.math.Long} other Long to compare against.
 * @return {boolean} Whether this Long is less than or equal to the other.
 */
goog.math.Long.prototype.lessThanOrEqual = function(other) {
  return this.compare(other) <= 0;
};


/**
 * @param {goog.math.Long} other Long to compare against.
 * @return {boolean} Whether this Long is greater than the other.
 */
goog.math.Long.prototype.greaterThan = function(other) {
  return this.compare(other) > 0;
};


/**
 * @param {goog.math.Long} other Long to compare against.
 * @return {boolean} Whether this Long is greater than or equal to the other.
 */
goog.math.Long.prototype.greaterThanOrEqual = function(other) {
  return this.compare(other) >= 0;
};


/**
 * Compares this Long with the given one.
 * @param {goog.math.Long} other Long to compare against.
 * @return {number} 0 if they are the same, 1 if the this is greater, and -1
 *     if the given one is greater.
 */
goog.math.Long.prototype.compare = function(other) {
  if (this.equals(other)) {
    return 0;
  }

  var thisNeg = this.isNegative();
  var otherNeg = other.isNegative();
  if (thisNeg && !otherNeg) {
    return -1;
  }
  if (!thisNeg && otherNeg) {
    return 1;
  }

  // at this point, the signs are the same, so subtraction will not overflow
  if (this.subtract(other).isNegative()) {
    return -1;
  } else {
    return 1;
  }
};


/** @return {!goog.math.Long} The negation of this value. */
goog.math.Long.prototype.negate = function() {
  if (this.equals(goog.math.Long.MIN_VALUE)) {
    return goog.math.Long.MIN_VALUE;
  } else {
    return this.not().add(goog.math.Long.ONE);
  }
};


/**
 * Returns the sum of this and the given Long.
 * @param {goog.math.Long} other Long to add to this one.
 * @return {!goog.math.Long} The sum of this and the given Long.
 */
goog.math.Long.prototype.add = function(other) {
  // Divide each number into 4 chunks of 16 bits, and then sum the chunks.

  var a48 = this.high_ >>> 16;
  var a32 = this.high_ & 0xFFFF;
  var a16 = this.low_ >>> 16;
  var a00 = this.low_ & 0xFFFF;

  var b48 = other.high_ >>> 16;
  var b32 = other.high_ & 0xFFFF;
  var b16 = other.low_ >>> 16;
  var b00 = other.low_ & 0xFFFF;

  var c48 = 0, c32 = 0, c16 = 0, c00 = 0;
  c00 += a00 + b00;
  c16 += c00 >>> 16;
  c00 &= 0xFFFF;
  c16 += a16 + b16;
  c32 += c16 >>> 16;
  c16 &= 0xFFFF;
  c32 += a32 + b32;
  c48 += c32 >>> 16;
  c32 &= 0xFFFF;
  c48 += a48 + b48;
  c48 &= 0xFFFF;
  return goog.math.Long.fromBits((c16 << 16) | c00, (c48 << 16) | c32);
};


/**
 * Returns the difference of this and the given Long.
 * @param {goog.math.Long} other Long to subtract from this.
 * @return {!goog.math.Long} The difference of this and the given Long.
 */
goog.math.Long.prototype.subtract = function(other) {
  return this.add(other.negate());
};


/**
 * Returns the product of this and the given long.
 * @param {goog.math.Long} other Long to multiply with this.
 * @return {!goog.math.Long} The product of this and the other.
 */
goog.math.Long.prototype.multiply = function(other) {
  if (this.isZero()) {
    return goog.math.Long.ZERO;
  } else if (other.isZero()) {
    return goog.math.Long.ZERO;
  }

  if (this.equals(goog.math.Long.MIN_VALUE)) {
    return other.isOdd() ? goog.math.Long.MIN_VALUE : goog.math.Long.ZERO;
  } else if (other.equals(goog.math.Long.MIN_VALUE)) {
    return this.isOdd() ? goog.math.Long.MIN_VALUE : goog.math.Long.ZERO;
  }

  if (this.isNegative()) {
    if (other.isNegative()) {
      return this.negate().multiply(other.negate());
    } else {
      return this.negate().multiply(other).negate();
    }
  } else if (other.isNegative()) {
    return this.multiply(other.negate()).negate();
  }

  // If both longs are small, use float multiplication
  if (this.lessThan(goog.math.Long.TWO_PWR_24_) &&
      other.lessThan(goog.math.Long.TWO_PWR_24_)) {
    return goog.math.Long.fromNumber(this.toNumber() * other.toNumber());
  }

  // Divide each long into 4 chunks of 16 bits, and then add up 4x4 products.
  // We can skip products that would overflow.

  var a48 = this.high_ >>> 16;
  var a32 = this.high_ & 0xFFFF;
  var a16 = this.low_ >>> 16;
  var a00 = this.low_ & 0xFFFF;

  var b48 = other.high_ >>> 16;
  var b32 = other.high_ & 0xFFFF;
  var b16 = other.low_ >>> 16;
  var b00 = other.low_ & 0xFFFF;

  var c48 = 0, c32 = 0, c16 = 0, c00 = 0;
  c00 += a00 * b00;
  c16 += c00 >>> 16;
  c00 &= 0xFFFF;
  c16 += a16 * b00;
  c32 += c16 >>> 16;
  c16 &= 0xFFFF;
  c16 += a00 * b16;
  c32 += c16 >>> 16;
  c16 &= 0xFFFF;
  c32 += a32 * b00;
  c48 += c32 >>> 16;
  c32 &= 0xFFFF;
  c32 += a16 * b16;
  c48 += c32 >>> 16;
  c32 &= 0xFFFF;
  c32 += a00 * b32;
  c48 += c32 >>> 16;
  c32 &= 0xFFFF;
  c48 += a48 * b00 + a32 * b16 + a16 * b32 + a00 * b48;
  c48 &= 0xFFFF;
  return goog.math.Long.fromBits((c16 << 16) | c00, (c48 << 16) | c32);
};


/**
 * Returns this Long divided by the given one.
 * @param {goog.math.Long} other Long by which to divide.
 * @return {!goog.math.Long} This Long divided by the given one.
 */
goog.math.Long.prototype.div = function(other) {
  if (other.isZero()) {
    throw Error('division by zero');
  } else if (this.isZero()) {
    return goog.math.Long.ZERO;
  }

  if (this.equals(goog.math.Long.MIN_VALUE)) {
    if (other.equals(goog.math.Long.ONE) ||
        other.equals(goog.math.Long.NEG_ONE)) {
      return goog.math.Long.MIN_VALUE;  // recall that -MIN_VALUE == MIN_VALUE
    } else if (other.equals(goog.math.Long.MIN_VALUE)) {
      return goog.math.Long.ONE;
    } else {
      // At this point, we have |other| >= 2, so |this/other| < |MIN_VALUE|.
      var halfThis = this.shiftRight(1);
      var approx = halfThis.div(other).shiftLeft(1);
      if (approx.equals(goog.math.Long.ZERO)) {
        return other.isNegative() ? goog.math.Long.ONE : goog.math.Long.NEG_ONE;
      } else {
        var rem = this.subtract(other.multiply(approx));
        var result = approx.add(rem.div(other));
        return result;
      }
    }
  } else if (other.equals(goog.math.Long.MIN_VALUE)) {
    return goog.math.Long.ZERO;
  }

  if (this.isNegative()) {
    if (other.isNegative()) {
      return this.negate().div(other.negate());
    } else {
      return this.negate().div(other).negate();
    }
  } else if (other.isNegative()) {
    return this.div(other.negate()).negate();
  }

  // Repeat the following until the remainder is less than other:  find a
  // floating-point that approximates remainder / other *from below*, add this
  // into the result, and subtract it from the remainder.  It is critical that
  // the approximate value is less than or equal to the real value so that the
  // remainder never becomes negative.
  var res = goog.math.Long.ZERO;
  var rem = this;
  while (rem.greaterThanOrEqual(other)) {
    // Approximate the result of division. This may be a little greater or
    // smaller than the actual value.
    var approx = Math.max(1, Math.floor(rem.toNumber() / other.toNumber()));

    // We will tweak the approximate result by changing it in the 48-th digit or
    // the smallest non-fractional digit, whichever is larger.
    var log2 = Math.ceil(Math.log(approx) / Math.LN2);
    var delta = (log2 <= 48) ? 1 : Math.pow(2, log2 - 48);

    // Decrease the approximation until it is smaller than the remainder.  Note
    // that if it is too large, the product overflows and is negative.
    var approxRes = goog.math.Long.fromNumber(approx);
    var approxRem = approxRes.multiply(other);
    while (approxRem.isNegative() || approxRem.greaterThan(rem)) {
      approx -= delta;
      approxRes = goog.math.Long.fromNumber(approx);
      approxRem = approxRes.multiply(other);
    }

    // We know the answer can't be zero... and actually, zero would cause
    // infinite recursion since we would make no progress.
    if (approxRes.isZero()) {
      approxRes = goog.math.Long.ONE;
    }

    res = res.add(approxRes);
    rem = rem.subtract(approxRem);
  }
  return res;
};


/**
 * Returns this Long modulo the given one.
 * @param {goog.math.Long} other Long by which to mod.
 * @return {!goog.math.Long} This Long modulo the given one.
 */
goog.math.Long.prototype.modulo = function(other) {
  return this.subtract(this.div(other).multiply(other));
};


/** @return {!goog.math.Long} The bitwise-NOT of this value. */
goog.math.Long.prototype.not = function() {
  return goog.math.Long.fromBits(~this.low_, ~this.high_);
};


/**
 * Returns the bitwise-AND of this Long and the given one.
 * @param {goog.math.Long} other The Long with which to AND.
 * @return {!goog.math.Long} The bitwise-AND of this and the other.
 */
goog.math.Long.prototype.and = function(other) {
  return goog.math.Long.fromBits(this.low_ & other.low_,
                                 this.high_ & other.high_);
};


/**
 * Returns the bitwise-OR of this Long and the given one.
 * @param {goog.math.Long} other The Long with which to OR.
 * @return {!goog.math.Long} The bitwise-OR of this and the other.
 */
goog.math.Long.prototype.or = function(other) {
  return goog.math.Long.fromBits(this.low_ | other.low_,
                                 this.high_ | other.high_);
};


/**
 * Returns the bitwise-XOR of this Long and the given one.
 * @param {goog.math.Long} other The Long with which to XOR.
 * @return {!goog.math.Long} The bitwise-XOR of this and the other.
 */
goog.math.Long.prototype.xor = function(other) {
  return goog.math.Long.fromBits(this.low_ ^ other.low_,
                                 this.high_ ^ other.high_);
};


/**
 * Returns this Long with bits shifted to the left by the given amount.
 * @param {number} numBits The number of bits by which to shift.
 * @return {!goog.math.Long} This shifted to the left by the given amount.
 */
goog.math.Long.prototype.shiftLeft = function(numBits) {
  numBits &= 63;
  if (numBits == 0) {
    return this;
  } else {
    var low = this.low_;
    if (numBits < 32) {
      var high = this.high_;
      return goog.math.Long.fromBits(
          low << numBits,
          (high << numBits) | (low >>> (32 - numBits)));
    } else {
      return goog.math.Long.fromBits(0, low << (numBits - 32));
    }
  }
};


/**
 * Returns this Long with bits shifted to the right by the given amount.
 * @param {number} numBits The number of bits by which to shift.
 * @return {!goog.math.Long} This shifted to the right by the given amount.
 */
goog.math.Long.prototype.shiftRight = function(numBits) {
  numBits &= 63;
  if (numBits == 0) {
    return this;
  } else {
    var high = this.high_;
    if (numBits < 32) {
      var low = this.low_;
      return goog.math.Long.fromBits(
          (low >>> numBits) | (high << (32 - numBits)),
          high >> numBits);
    } else {
      return goog.math.Long.fromBits(
          high >> (numBits - 32),
          high >= 0 ? 0 : -1);
    }
  }
};


/**
 * Returns this Long with bits shifted to the right by the given amount, with
 * the new top bits matching the current sign bit.
 * @param {number} numBits The number of bits by which to shift.
 * @return {!goog.math.Long} This shifted to the right by the given amount, with
 *     zeros placed into the new leading bits.
 */
goog.math.Long.prototype.shiftRightUnsigned = function(numBits) {
  numBits &= 63;
  if (numBits == 0) {
    return this;
  } else {
    var high = this.high_;
    if (numBits < 32) {
      var low = this.low_;
      return goog.math.Long.fromBits(
          (low >>> numBits) | (high << (32 - numBits)),
          high >>> numBits);
    } else if (numBits == 32) {
      return goog.math.Long.fromBits(high, 0);
    } else {
      return goog.math.Long.fromBits(high >>> (numBits - 32), 0);
    }
  }
};

// Copyright 2006 The Closure Library Authors. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS-IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * @fileoverview Utilities for manipulating objects/maps/hashes.
 */

goog.provide('goog.object');


/**
 * Calls a function for each element in an object/map/hash.
 *
 * @param {Object.<K,V>} obj The object over which to iterate.
 * @param {function(this:T,V,?,Object.<K,V>):?} f The function to call
 *     for every element. This function takes 3 arguments (the element, the
 *     index and the object) and the return value is ignored.
 * @param {T=} opt_obj This is used as the 'this' object within f.
 * @template T,K,V
 */
goog.object.forEach = function(obj, f, opt_obj) {
  for (var key in obj) {
    f.call(opt_obj, obj[key], key, obj);
  }
};


/**
 * Calls a function for each element in an object/map/hash. If that call returns
 * true, adds the element to a new object.
 *
 * @param {Object.<K,V>} obj The object over which to iterate.
 * @param {function(this:T,V,?,Object.<K,V>):boolean} f The function to call
 *     for every element. This
 *     function takes 3 arguments (the element, the index and the object)
 *     and should return a boolean. If the return value is true the
 *     element is added to the result object. If it is false the
 *     element is not included.
 * @param {T=} opt_obj This is used as the 'this' object within f.
 * @return {!Object.<K,V>} a new object in which only elements that passed the
 *     test are present.
 * @template T,K,V
 */
goog.object.filter = function(obj, f, opt_obj) {
  var res = {};
  for (var key in obj) {
    if (f.call(opt_obj, obj[key], key, obj)) {
      res[key] = obj[key];
    }
  }
  return res;
};


/**
 * For every element in an object/map/hash calls a function and inserts the
 * result into a new object.
 *
 * @param {Object.<K,V>} obj The object over which to iterate.
 * @param {function(this:T,V,?,Object.<K,V>):R} f The function to call
 *     for every element. This function
 *     takes 3 arguments (the element, the index and the object)
 *     and should return something. The result will be inserted
 *     into a new object.
 * @param {T=} opt_obj This is used as the 'this' object within f.
 * @return {!Object.<T,R>} a new object with the results from f.
 * @template T,K,V,R
 */
goog.object.map = function(obj, f, opt_obj) {
  var res = {};
  for (var key in obj) {
    res[key] = f.call(opt_obj, obj[key], key, obj);
  }
  return res;
};


/**
 * Calls a function for each element in an object/map/hash. If any
 * call returns true, returns true (without checking the rest). If
 * all calls return false, returns false.
 *
 * @param {Object.<K,V>} obj The object to check.
 * @param {function(this:T,V,?,Object.<K,V>):boolean} f The function to
 *     call for every element. This function
 *     takes 3 arguments (the element, the index and the object) and should
 *     return a boolean.
 * @param {T=} opt_obj This is used as the 'this' object within f.
 * @return {boolean} true if any element passes the test.
 * @template T,K,V
 */
goog.object.some = function(obj, f, opt_obj) {
  for (var key in obj) {
    if (f.call(opt_obj, obj[key], key, obj)) {
      return true;
    }
  }
  return false;
};


/**
 * Calls a function for each element in an object/map/hash. If
 * all calls return true, returns true. If any call returns false, returns
 * false at this point and does not continue to check the remaining elements.
 *
 * @param {Object.<K,V>} obj The object to check.
 * @param {?function(this:T,V,?,Object.<K,V>):boolean} f The function to
 *     call for every element. This function
 *     takes 3 arguments (the element, the index and the object) and should
 *     return a boolean.
 * @param {T=} opt_obj This is used as the 'this' object within f.
 * @return {boolean} false if any element fails the test.
 * @template T,K,V
 */
goog.object.every = function(obj, f, opt_obj) {
  for (var key in obj) {
    if (!f.call(opt_obj, obj[key], key, obj)) {
      return false;
    }
  }
  return true;
};


/**
 * Returns the number of key-value pairs in the object map.
 *
 * @param {Object} obj The object for which to get the number of key-value
 *     pairs.
 * @return {number} The number of key-value pairs in the object map.
 */
goog.object.getCount = function(obj) {
  // JS1.5 has __count__ but it has been deprecated so it raises a warning...
  // in other words do not use. Also __count__ only includes the fields on the
  // actual object and not in the prototype chain.
  var rv = 0;
  for (var key in obj) {
    rv++;
  }
  return rv;
};


/**
 * Returns one key from the object map, if any exists.
 * For map literals the returned key will be the first one in most of the
 * browsers (a know exception is Konqueror).
 *
 * @param {Object} obj The object to pick a key from.
 * @return {string|undefined} The key or undefined if the object is empty.
 */
goog.object.getAnyKey = function(obj) {
  for (var key in obj) {
    return key;
  }
};


/**
 * Returns one value from the object map, if any exists.
 * For map literals the returned value will be the first one in most of the
 * browsers (a know exception is Konqueror).
 *
 * @param {Object.<K,V>} obj The object to pick a value from.
 * @return {V|undefined} The value or undefined if the object is empty.
 * @template K,V
 */
goog.object.getAnyValue = function(obj) {
  for (var key in obj) {
    return obj[key];
  }
};


/**
 * Whether the object/hash/map contains the given object as a value.
 * An alias for goog.object.containsValue(obj, val).
 *
 * @param {Object.<K,V>} obj The object in which to look for val.
 * @param {V} val The object for which to check.
 * @return {boolean} true if val is present.
 * @template K,V
 */
goog.object.contains = function(obj, val) {
  return goog.object.containsValue(obj, val);
};


/**
 * Returns the values of the object/map/hash.
 *
 * @param {Object.<K,V>} obj The object from which to get the values.
 * @return {!Array.<V>} The values in the object/map/hash.
 * @template K,V
 */
goog.object.getValues = function(obj) {
  var res = [];
  var i = 0;
  for (var key in obj) {
    res[i++] = obj[key];
  }
  return res;
};


/**
 * Returns the keys of the object/map/hash.
 *
 * @param {Object} obj The object from which to get the keys.
 * @return {!Array.<string>} Array of property keys.
 */
goog.object.getKeys = function(obj) {
  var res = [];
  var i = 0;
  for (var key in obj) {
    res[i++] = key;
  }
  return res;
};


/**
 * Get a value from an object multiple levels deep.  This is useful for
 * pulling values from deeply nested objects, such as JSON responses.
 * Example usage: getValueByKeys(jsonObj, 'foo', 'entries', 3)
 *
 * @param {!Object} obj An object to get the value from.  Can be array-like.
 * @param {...(string|number|!Array.<number|string>)} var_args A number of keys
 *     (as strings, or nubmers, for array-like objects).  Can also be
 *     specified as a single array of keys.
 * @return {*} The resulting value.  If, at any point, the value for a key
 *     is undefined, returns undefined.
 */
goog.object.getValueByKeys = function(obj, var_args) {
  var isArrayLike = goog.isArrayLike(var_args);
  var keys = isArrayLike ? var_args : arguments;

  // Start with the 2nd parameter for the variable parameters syntax.
  for (var i = isArrayLike ? 0 : 1; i < keys.length; i++) {
    obj = obj[keys[i]];
    if (!goog.isDef(obj)) {
      break;
    }
  }

  return obj;
};


/**
 * Whether the object/map/hash contains the given key.
 *
 * @param {Object} obj The object in which to look for key.
 * @param {*} key The key for which to check.
 * @return {boolean} true If the map contains the key.
 */
goog.object.containsKey = function(obj, key) {
  return key in obj;
};


/**
 * Whether the object/map/hash contains the given value. This is O(n).
 *
 * @param {Object.<K,V>} obj The object in which to look for val.
 * @param {V} val The value for which to check.
 * @return {boolean} true If the map contains the value.
 * @template K,V
 */
goog.object.containsValue = function(obj, val) {
  for (var key in obj) {
    if (obj[key] == val) {
      return true;
    }
  }
  return false;
};


/**
 * Searches an object for an element that satisfies the given condition and
 * returns its key.
 * @param {Object.<K,V>} obj The object to search in.
 * @param {function(this:T,V,string,Object.<K,V>):boolean} f The
 *      function to call for every element. Takes 3 arguments (the value,
 *     the key and the object) and should return a boolean.
 * @param {T=} opt_this An optional "this" context for the function.
 * @return {string|undefined} The key of an element for which the function
 *     returns true or undefined if no such element is found.
 * @template T,K,V
 */
goog.object.findKey = function(obj, f, opt_this) {
  for (var key in obj) {
    if (f.call(opt_this, obj[key], key, obj)) {
      return key;
    }
  }
  return undefined;
};


/**
 * Searches an object for an element that satisfies the given condition and
 * returns its value.
 * @param {Object.<K,V>} obj The object to search in.
 * @param {function(this:T,V,string,Object.<K,V>):boolean} f The function
 *     to call for every element. Takes 3 arguments (the value, the key
 *     and the object) and should return a boolean.
 * @param {T=} opt_this An optional "this" context for the function.
 * @return {V} The value of an element for which the function returns true or
 *     undefined if no such element is found.
 * @template T,K,V
 */
goog.object.findValue = function(obj, f, opt_this) {
  var key = goog.object.findKey(obj, f, opt_this);
  return key && obj[key];
};


/**
 * Whether the object/map/hash is empty.
 *
 * @param {Object} obj The object to test.
 * @return {boolean} true if obj is empty.
 */
goog.object.isEmpty = function(obj) {
  for (var key in obj) {
    return false;
  }
  return true;
};


/**
 * Removes all key value pairs from the object/map/hash.
 *
 * @param {Object} obj The object to clear.
 */
goog.object.clear = function(obj) {
  for (var i in obj) {
    delete obj[i];
  }
};


/**
 * Removes a key-value pair based on the key.
 *
 * @param {Object} obj The object from which to remove the key.
 * @param {*} key The key to remove.
 * @return {boolean} Whether an element was removed.
 */
goog.object.remove = function(obj, key) {
  var rv;
  if ((rv = key in obj)) {
    delete obj[key];
  }
  return rv;
};


/**
 * Adds a key-value pair to the object. Throws an exception if the key is
 * already in use. Use set if you want to change an existing pair.
 *
 * @param {Object.<K,V>} obj The object to which to add the key-value pair.
 * @param {string} key The key to add.
 * @param {V} val The value to add.
 * @template K,V
 */
goog.object.add = function(obj, key, val) {
  if (key in obj) {
    throw Error('The object already contains the key "' + key + '"');
  }
  goog.object.set(obj, key, val);
};


/**
 * Returns the value for the given key.
 *
 * @param {Object.<K,V>} obj The object from which to get the value.
 * @param {string} key The key for which to get the value.
 * @param {R=} opt_val The value to return if no item is found for the given
 *     key (default is undefined).
 * @return {V|R|undefined} The value for the given key.
 * @template K,V,R
 */
goog.object.get = function(obj, key, opt_val) {
  if (key in obj) {
    return obj[key];
  }
  return opt_val;
};


/**
 * Adds a key-value pair to the object/map/hash.
 *
 * @param {Object.<K,V>} obj The object to which to add the key-value pair.
 * @param {string} key The key to add.
 * @param {K} value The value to add.
 * @template K,V
 */
goog.object.set = function(obj, key, value) {
  obj[key] = value;
};


/**
 * Adds a key-value pair to the object/map/hash if it doesn't exist yet.
 *
 * @param {Object.<K,V>} obj The object to which to add the key-value pair.
 * @param {string} key The key to add.
 * @param {V} value The value to add if the key wasn't present.
 * @return {V} The value of the entry at the end of the function.
 * @template K,V
 */
goog.object.setIfUndefined = function(obj, key, value) {
  return key in obj ? obj[key] : (obj[key] = value);
};


/**
 * Does a flat clone of the object.
 *
 * @param {Object.<K,V>} obj Object to clone.
 * @return {!Object.<K,V>} Clone of the input object.
 * @template K,V
 */
goog.object.clone = function(obj) {
  // We cannot use the prototype trick because a lot of methods depend on where
  // the actual key is set.

  var res = {};
  for (var key in obj) {
    res[key] = obj[key];
  }
  return res;
  // We could also use goog.mixin but I wanted this to be independent from that.
};


/**
 * Clones a value. The input may be an Object, Array, or basic type. Objects and
 * arrays will be cloned recursively.
 *
 * WARNINGS:
 * <code>goog.object.unsafeClone</code> does not detect reference loops. Objects
 * that refer to themselves will cause infinite recursion.
 *
 * <code>goog.object.unsafeClone</code> is unaware of unique identifiers, and
 * copies UIDs created by <code>getUid</code> into cloned results.
 *
 * @param {*} obj The value to clone.
 * @return {*} A clone of the input value.
 */
goog.object.unsafeClone = function(obj) {
  var type = goog.typeOf(obj);
  if (type == 'object' || type == 'array') {
    if (obj.clone) {
      return obj.clone();
    }
    var clone = type == 'array' ? [] : {};
    for (var key in obj) {
      clone[key] = goog.object.unsafeClone(obj[key]);
    }
    return clone;
  }

  return obj;
};


/**
 * Returns a new object in which all the keys and values are interchanged
 * (keys become values and values become keys). If multiple keys map to the
 * same value, the chosen transposed value is implementation-dependent.
 *
 * @param {Object} obj The object to transpose.
 * @return {!Object} The transposed object.
 */
goog.object.transpose = function(obj) {
  var transposed = {};
  for (var key in obj) {
    transposed[obj[key]] = key;
  }
  return transposed;
};


/**
 * The names of the fields that are defined on Object.prototype.
 * @type {Array.<string>}
 * @private
 */
goog.object.PROTOTYPE_FIELDS_ = [
  'constructor',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  'toString',
  'valueOf'
];


/**
 * Extends an object with another object.
 * This operates 'in-place'; it does not create a new Object.
 *
 * Example:
 * var o = {};
 * goog.object.extend(o, {a: 0, b: 1});
 * o; // {a: 0, b: 1}
 * goog.object.extend(o, {c: 2});
 * o; // {a: 0, b: 1, c: 2}
 *
 * @param {Object} target  The object to modify.
 * @param {...Object} var_args The objects from which values will be copied.
 */
goog.object.extend = function(target, var_args) {
  var key, source;
  for (var i = 1; i < arguments.length; i++) {
    source = arguments[i];
    for (key in source) {
      target[key] = source[key];
    }

    // For IE the for-in-loop does not contain any properties that are not
    // enumerable on the prototype object (for example isPrototypeOf from
    // Object.prototype) and it will also not include 'replace' on objects that
    // extend String and change 'replace' (not that it is common for anyone to
    // extend anything except Object).

    for (var j = 0; j < goog.object.PROTOTYPE_FIELDS_.length; j++) {
      key = goog.object.PROTOTYPE_FIELDS_[j];
      if (Object.prototype.hasOwnProperty.call(source, key)) {
        target[key] = source[key];
      }
    }
  }
};


/**
 * Creates a new object built from the key-value pairs provided as arguments.
 * @param {...*} var_args If only one argument is provided and it is an array
 *     then this is used as the arguments,  otherwise even arguments are used as
 *     the property names and odd arguments are used as the property values.
 * @return {!Object} The new object.
 * @throws {Error} If there are uneven number of arguments or there is only one
 *     non array argument.
 */
goog.object.create = function(var_args) {
  var argLength = arguments.length;
  if (argLength == 1 && goog.isArray(arguments[0])) {
    return goog.object.create.apply(null, arguments[0]);
  }

  if (argLength % 2) {
    throw Error('Uneven number of arguments');
  }

  var rv = {};
  for (var i = 0; i < argLength; i += 2) {
    rv[arguments[i]] = arguments[i + 1];
  }
  return rv;
};


/**
 * Creates a new object where the property names come from the arguments but
 * the value is always set to true
 * @param {...*} var_args If only one argument is provided and it is an array
 *     then this is used as the arguments,  otherwise the arguments are used
 *     as the property names.
 * @return {!Object} The new object.
 */
goog.object.createSet = function(var_args) {
  var argLength = arguments.length;
  if (argLength == 1 && goog.isArray(arguments[0])) {
    return goog.object.createSet.apply(null, arguments[0]);
  }

  var rv = {};
  for (var i = 0; i < argLength; i++) {
    rv[arguments[i]] = true;
  }
  return rv;
};


/**
 * Creates an immutable view of the underlying object, if the browser
 * supports immutable objects.
 *
 * In default mode, writes to this view will fail silently. In strict mode,
 * they will throw an error.
 *
 * @param {!Object.<K,V>} obj An object.
 * @return {!Object.<K,V>} An immutable view of that object, or the
 *     original object if this browser does not support immutables.
 * @template K,V
 */
goog.object.createImmutableView = function(obj) {
  var result = obj;
  if (Object.isFrozen && !Object.isFrozen(obj)) {
    result = Object.create(obj);
    Object.freeze(result);
  }
  return result;
};


/**
 * @param {!Object} obj An object.
 * @return {boolean} Whether this is an immutable view of the object.
 */
goog.object.isImmutableView = function(obj) {
  return !!Object.isFrozen && Object.isFrozen(obj);
};

// Copyright 2007 The Closure Library Authors. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS-IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * @fileoverview Python style iteration utilities.
 * @author arv@google.com (Erik Arvidsson)
 */


goog.provide('goog.iter');
goog.provide('goog.iter.Iterator');
goog.provide('goog.iter.StopIteration');

goog.require('goog.array');
goog.require('goog.asserts');


// TODO(nnaze): Add more functions from Python's itertools.
// http://docs.python.org/library/itertools.html


/**
 * @typedef {goog.iter.Iterator|{length:number}|{__iterator__}}
 */
goog.iter.Iterable;


// For script engines that already support iterators.
if ('StopIteration' in goog.global) {
  /**
   * Singleton Error object that is used to terminate iterations.
   * @type {Error}
   */
  goog.iter.StopIteration = goog.global['StopIteration'];
} else {
  /**
   * Singleton Error object that is used to terminate iterations.
   * @type {Error}
   * @suppress {duplicate}
   */
  goog.iter.StopIteration = Error('StopIteration');
}



/**
 * Class/interface for iterators.  An iterator needs to implement a {@code next}
 * method and it needs to throw a {@code goog.iter.StopIteration} when the
 * iteration passes beyond the end.  Iterators have no {@code hasNext} method.
 * It is recommended to always use the helper functions to iterate over the
 * iterator or in case you are only targeting JavaScript 1.7 for in loops.
 * @constructor
 */
goog.iter.Iterator = function() {};


/**
 * Returns the next value of the iteration.  This will throw the object
 * {@see goog.iter#StopIteration} when the iteration passes the end.
 * @return {*} Any object or value.
 */
goog.iter.Iterator.prototype.next = function() {
  throw goog.iter.StopIteration;
};


/**
 * Returns the {@code Iterator} object itself.  This is used to implement
 * the iterator protocol in JavaScript 1.7
 * @param {boolean=} opt_keys  Whether to return the keys or values. Default is
 *     to only return the values.  This is being used by the for-in loop (true)
 *     and the for-each-in loop (false).  Even though the param gives a hint
 *     about what the iterator will return there is no guarantee that it will
 *     return the keys when true is passed.
 * @return {!goog.iter.Iterator} The object itself.
 */
goog.iter.Iterator.prototype.__iterator__ = function(opt_keys) {
  return this;
};


/**
 * Returns an iterator that knows how to iterate over the values in the object.
 * @param {goog.iter.Iterable} iterable  If the object is an iterator it
 *     will be returned as is.  If the object has a {@code __iterator__} method
 *     that will be called to get the value iterator.  If the object is an
 *     array-like object we create an iterator for that.
 * @return {!goog.iter.Iterator} An iterator that knows how to iterate over the
 *     values in {@code iterable}.
 */
goog.iter.toIterator = function(iterable) {
  if (iterable instanceof goog.iter.Iterator) {
    return iterable;
  }
  if (typeof iterable.__iterator__ == 'function') {
    return iterable.__iterator__(false);
  }
  if (goog.isArrayLike(iterable)) {
    var i = 0;
    var newIter = new goog.iter.Iterator;
    newIter.next = function() {
      while (true) {
        if (i >= iterable.length) {
          throw goog.iter.StopIteration;
        }
        // Don't include deleted elements.
        if (!(i in iterable)) {
          i++;
          continue;
        }
        return iterable[i++];
      }
    };
    return newIter;
  }


  // TODO(arv): Should we fall back on goog.structs.getValues()?
  throw Error('Not implemented');
};


/**
 * Calls a function for each element in the iterator with the element of the
 * iterator passed as argument.
 *
 * @param {goog.iter.Iterable} iterable  The iterator to iterate
 *     over.  If the iterable is an object {@code toIterator} will be called on
 *     it.
* @param {function(this:T,?,?,?):?} f  The function to call for every
 *     element.  This function
 *     takes 3 arguments (the element, undefined, and the iterator) and the
 *     return value is irrelevant.  The reason for passing undefined as the
 *     second argument is so that the same function can be used in
 *     {@see goog.array#forEach} as well as others.
 * @param {T=} opt_obj  The object to be used as the value of 'this' within
 *     {@code f}.
 * @template T
 */
goog.iter.forEach = function(iterable, f, opt_obj) {
  if (goog.isArrayLike(iterable)) {
    /** @preserveTry */
    try {
      // NOTES: this passes the index number to the second parameter
      // of the callback contrary to the documentation above.
      goog.array.forEach(/** @type {goog.array.ArrayLike} */(iterable), f,
                         opt_obj);
    } catch (ex) {
      if (ex !== goog.iter.StopIteration) {
        throw ex;
      }
    }
  } else {
    iterable = goog.iter.toIterator(iterable);
    /** @preserveTry */
    try {
      while (true) {
        f.call(opt_obj, iterable.next(), undefined, iterable);
      }
    } catch (ex) {
      if (ex !== goog.iter.StopIteration) {
        throw ex;
      }
    }
  }
};


/**
 * Calls a function for every element in the iterator, and if the function
 * returns true adds the element to a new iterator.
 *
 * @param {goog.iter.Iterable} iterable The iterator to iterate over.
 * @param {function(this:T,?,undefined,?):boolean} f The function to call for
 *     every element. This function
 *     takes 3 arguments (the element, undefined, and the iterator) and should
 *     return a boolean.  If the return value is true the element will be
 *     included  in the returned iteror.  If it is false the element is not
 *     included.
 * @param {T=} opt_obj The object to be used as the value of 'this' within
 *     {@code f}.
 * @return {!goog.iter.Iterator} A new iterator in which only elements that
 *     passed the test are present.
 * @template T
 */
goog.iter.filter = function(iterable, f, opt_obj) {
  var iterator = goog.iter.toIterator(iterable);
  var newIter = new goog.iter.Iterator;
  newIter.next = function() {
    while (true) {
      var val = iterator.next();
      if (f.call(opt_obj, val, undefined, iterator)) {
        return val;
      }
    }
  };
  return newIter;
};


/**
 * Creates a new iterator that returns the values in a range.  This function
 * can take 1, 2 or 3 arguments:
 * <pre>
 * range(5) same as range(0, 5, 1)
 * range(2, 5) same as range(2, 5, 1)
 * </pre>
 *
 * @param {number} startOrStop  The stop value if only one argument is provided.
 *     The start value if 2 or more arguments are provided.  If only one
 *     argument is used the start value is 0.
 * @param {number=} opt_stop  The stop value.  If left out then the first
 *     argument is used as the stop value.
 * @param {number=} opt_step  The number to increment with between each call to
 *     next.  This can be negative.
 * @return {!goog.iter.Iterator} A new iterator that returns the values in the
 *     range.
 */
goog.iter.range = function(startOrStop, opt_stop, opt_step) {
  var start = 0;
  var stop = startOrStop;
  var step = opt_step || 1;
  if (arguments.length > 1) {
    start = startOrStop;
    stop = opt_stop;
  }
  if (step == 0) {
    throw Error('Range step argument must not be zero');
  }

  var newIter = new goog.iter.Iterator;
  newIter.next = function() {
    if (step > 0 && start >= stop || step < 0 && start <= stop) {
      throw goog.iter.StopIteration;
    }
    var rv = start;
    start += step;
    return rv;
  };
  return newIter;
};


/**
 * Joins the values in a iterator with a delimiter.
 * @param {goog.iter.Iterable} iterable  The iterator to get the values from.
 * @param {string} deliminator  The text to put between the values.
 * @return {string} The joined value string.
 */
goog.iter.join = function(iterable, deliminator) {
  return goog.iter.toArray(iterable).join(deliminator);
};


/**
 * For every element in the iterator call a function and return a new iterator
 * with that value.
 *
 * @param {goog.iter.Iterable} iterable The iterator to iterate over.
 * @param {function(this:T,?,undefined,?):?} f The function to call for every
 *     element.  This function
 *     takes 3 arguments (the element, undefined, and the iterator) and should
 *     return a new value.
 * @param {T=} opt_obj The object to be used as the value of 'this' within
 *     {@code f}.
 * @return {!goog.iter.Iterator} A new iterator that returns the results of
 *     applying the function to each element in the original iterator.
 * @template T
 */
goog.iter.map = function(iterable, f, opt_obj) {
  var iterator = goog.iter.toIterator(iterable);
  var newIter = new goog.iter.Iterator;
  newIter.next = function() {
    while (true) {
      var val = iterator.next();
      return f.call(opt_obj, val, undefined, iterator);
    }
  };
  return newIter;
};


/**
 * Passes every element of an iterator into a function and accumulates the
 * result.
 *
 * @param {goog.iter.Iterable} iterable The iterator to iterate over.
 * @param {function(this:T,V,?):V} f The function to call for every
 *     element. This function takes 2 arguments (the function's previous result
 *     or the initial value, and the value of the current element).
 *     function(previousValue, currentElement) : newValue.
 * @param {V} val The initial value to pass into the function on the first call.
 * @param {T=} opt_obj  The object to be used as the value of 'this'
 *     within f.
 * @return {V} Result of evaluating f repeatedly across the values of
 *     the iterator.
 * @template T,V
 */
goog.iter.reduce = function(iterable, f, val, opt_obj) {
  var rval = val;
  goog.iter.forEach(iterable, function(val) {
    rval = f.call(opt_obj, rval, val);
  });
  return rval;
};


/**
 * Goes through the values in the iterator. Calls f for each these and if any of
 * them returns true, this returns true (without checking the rest). If all
 * return false this will return false.
 *
 * @param {goog.iter.Iterable} iterable  The iterator object.
 * @param {function(this:T,?,undefined,?):boolean} f  The function to call for
 *     every value. This function
 *     takes 3 arguments (the value, undefined, and the iterator) and should
 *     return a boolean.
 * @param {T=} opt_obj The object to be used as the value of 'this' within
 *     {@code f}.
 * @return {boolean} true if any value passes the test.
 * @template T
 */
goog.iter.some = function(iterable, f, opt_obj) {
  iterable = goog.iter.toIterator(iterable);
  /** @preserveTry */
  try {
    while (true) {
      if (f.call(opt_obj, iterable.next(), undefined, iterable)) {
        return true;
      }
    }
  } catch (ex) {
    if (ex !== goog.iter.StopIteration) {
      throw ex;
    }
  }
  return false;
};


/**
 * Goes through the values in the iterator. Calls f for each these and if any of
 * them returns false this returns false (without checking the rest). If all
 * return true this will return true.
 *
 * @param {goog.iter.Iterable} iterable  The iterator object.
 * @param {function(this:T,?,undefined,?):boolean} f  The function to call for
 *     every value. This function
 *     takes 3 arguments (the value, undefined, and the iterator) and should
 *     return a boolean.
 * @param {T=} opt_obj The object to be used as the value of 'this' within
 *     {@code f}.
 * @return {boolean} true if every value passes the test.
 * @template T
 */
goog.iter.every = function(iterable, f, opt_obj) {
  iterable = goog.iter.toIterator(iterable);
  /** @preserveTry */
  try {
    while (true) {
      if (!f.call(opt_obj, iterable.next(), undefined, iterable)) {
        return false;
      }
    }
  } catch (ex) {
    if (ex !== goog.iter.StopIteration) {
      throw ex;
    }
  }
  return true;
};


/**
 * Takes zero or more iterators and returns one iterator that will iterate over
 * them in the order chained.
 * @param {...goog.iter.Iterator} var_args  Any number of iterator objects.
 * @return {!goog.iter.Iterator} Returns a new iterator that will iterate over
 *     all the given iterators' contents.
 */
goog.iter.chain = function(var_args) {
  var args = arguments;
  var length = args.length;
  var i = 0;
  var newIter = new goog.iter.Iterator;

  /**
   * @return {*} The next item in the iteration.
   * @this {goog.iter.Iterator}
   */
  newIter.next = function() {
    /** @preserveTry */
    try {
      if (i >= length) {
        throw goog.iter.StopIteration;
      }
      var current = goog.iter.toIterator(args[i]);
      return current.next();
    } catch (ex) {
      if (ex !== goog.iter.StopIteration || i >= length) {
        throw ex;
      } else {
        // In case we got a StopIteration increment counter and try again.
        i++;
        return this.next();
      }
    }
  };

  return newIter;
};


/**
 * Builds a new iterator that iterates over the original, but skips elements as
 * long as a supplied function returns true.
 * @param {goog.iter.Iterable} iterable  The iterator object.
 * @param {function(this:T,?,undefined,?):boolean} f  The function to call for
 *     every value. This function
 *     takes 3 arguments (the value, undefined, and the iterator) and should
 *     return a boolean.
 * @param {T=} opt_obj The object to be used as the value of 'this' within
 *     {@code f}.
 * @return {!goog.iter.Iterator} A new iterator that drops elements from the
 *     original iterator as long as {@code f} is true.
 * @template T
 */
goog.iter.dropWhile = function(iterable, f, opt_obj) {
  var iterator = goog.iter.toIterator(iterable);
  var newIter = new goog.iter.Iterator;
  var dropping = true;
  newIter.next = function() {
    while (true) {
      var val = iterator.next();
      if (dropping && f.call(opt_obj, val, undefined, iterator)) {
        continue;
      } else {
        dropping = false;
      }
      return val;
    }
  };
  return newIter;
};


/**
 * Builds a new iterator that iterates over the original, but only as long as a
 * supplied function returns true.
 * @param {goog.iter.Iterable} iterable  The iterator object.
 * @param {function(this:T,?,undefined,?):boolean} f  The function to call for
 *     every value. This function
 *     takes 3 arguments (the value, undefined, and the iterator) and should
 *     return a boolean.
 * @param {T=} opt_obj This is used as the 'this' object in f when called.
 * @return {!goog.iter.Iterator} A new iterator that keeps elements in the
 *     original iterator as long as the function is true.
 * @template T
 */
goog.iter.takeWhile = function(iterable, f, opt_obj) {
  var iterator = goog.iter.toIterator(iterable);
  var newIter = new goog.iter.Iterator;
  var taking = true;
  newIter.next = function() {
    while (true) {
      if (taking) {
        var val = iterator.next();
        if (f.call(opt_obj, val, undefined, iterator)) {
          return val;
        } else {
          taking = false;
        }
      } else {
        throw goog.iter.StopIteration;
      }
    }
  };
  return newIter;
};


/**
 * Converts the iterator to an array
 * @param {goog.iter.Iterable} iterable  The iterator to convert to an array.
 * @return {!Array} An array of the elements the iterator iterates over.
 */
goog.iter.toArray = function(iterable) {
  // Fast path for array-like.
  if (goog.isArrayLike(iterable)) {
    return goog.array.toArray(/** @type {!goog.array.ArrayLike} */(iterable));
  }
  iterable = goog.iter.toIterator(iterable);
  var array = [];
  goog.iter.forEach(iterable, function(val) {
    array.push(val);
  });
  return array;
};


/**
 * Iterates over 2 iterators and returns true if they contain the same sequence
 * of elements and have the same length.
 * @param {goog.iter.Iterable} iterable1  The first iterable object.
 * @param {goog.iter.Iterable} iterable2  The second iterable object.
 * @return {boolean} true if the iterators contain the same sequence of
 *     elements and have the same length.
 */
goog.iter.equals = function(iterable1, iterable2) {
  iterable1 = goog.iter.toIterator(iterable1);
  iterable2 = goog.iter.toIterator(iterable2);
  var b1, b2;
  /** @preserveTry */
  try {
    while (true) {
      b1 = b2 = false;
      var val1 = iterable1.next();
      b1 = true;
      var val2 = iterable2.next();
      b2 = true;
      if (val1 != val2) {
        return false;
      }
    }
  } catch (ex) {
    if (ex !== goog.iter.StopIteration) {
      throw ex;
    } else {
      if (b1 && !b2) {
        // iterable1 done but iterable2 is not done.
        return false;
      }
      if (!b2) {
        /** @preserveTry */
        try {
          // iterable2 not done?
          val2 = iterable2.next();
          // iterable2 not done but iterable1 is done
          return false;
        } catch (ex1) {
          if (ex1 !== goog.iter.StopIteration) {
            throw ex1;
          }
          // iterable2 done as well... They are equal
          return true;
        }
      }
    }
  }
  return false;
};


/**
 * Advances the iterator to the next position, returning the given default value
 * instead of throwing an exception if the iterator has no more entries.
 * @param {goog.iter.Iterable} iterable The iterable object.
 * @param {*} defaultValue The value to return if the iterator is empty.
 * @return {*} The next item in the iteration, or defaultValue if the iterator
 *     was empty.
 */
goog.iter.nextOrValue = function(iterable, defaultValue) {
  try {
    return goog.iter.toIterator(iterable).next();
  } catch (e) {
    if (e != goog.iter.StopIteration) {
      throw e;
    }
    return defaultValue;
  }
};


/**
 * Cartesian product of zero or more sets.  Gives an iterator that gives every
 * combination of one element chosen from each set.  For example,
 * ([1, 2], [3, 4]) gives ([1, 3], [1, 4], [2, 3], [2, 4]).
 * @see http://docs.python.org/library/itertools.html#itertools.product
 * @param {...!goog.array.ArrayLike.<*>} var_args Zero or more sets, as arrays.
 * @return {!goog.iter.Iterator} An iterator that gives each n-tuple (as an
 *     array).
 */
goog.iter.product = function(var_args) {
  var someArrayEmpty = goog.array.some(arguments, function(arr) {
    return !arr.length;
  });

  // An empty set in a cartesian product gives an empty set.
  if (someArrayEmpty || !arguments.length) {
    return new goog.iter.Iterator();
  }

  var iter = new goog.iter.Iterator();
  var arrays = arguments;

  // The first indicies are [0, 0, ...]
  var indicies = goog.array.repeat(0, arrays.length);

  iter.next = function() {

    if (indicies) {
      var retVal = goog.array.map(indicies, function(valueIndex, arrayIndex) {
        return arrays[arrayIndex][valueIndex];
      });

      // Generate the next-largest indicies for the next call.
      // Increase the rightmost index. If it goes over, increase the next
      // rightmost (like carry-over addition).
      for (var i = indicies.length - 1; i >= 0; i--) {
        // Assertion prevents compiler warning below.
        goog.asserts.assert(indicies);
        if (indicies[i] < arrays[i].length - 1) {
          indicies[i]++;
          break;
        }

        // We're at the last indicies (the last element of every array), so
        // the iteration is over on the next call.
        if (i == 0) {
          indicies = null;
          break;
        }
        // Reset the index in this column and loop back to increment the
        // next one.
        indicies[i] = 0;
      }
      return retVal;
    }

    throw goog.iter.StopIteration;
  };

  return iter;
};


/**
 * Create an iterator to cycle over the iterable's elements indefinitely.
 * For example, ([1, 2, 3]) would return : 1, 2, 3, 1, 2, 3, ...
 * @see: http://docs.python.org/library/itertools.html#itertools.cycle.
 * @param {!goog.iter.Iterable} iterable The iterable object.
 * @return {!goog.iter.Iterator} An iterator that iterates indefinitely over
 * the values in {@code iterable}.
 */
goog.iter.cycle = function(iterable) {

  var baseIterator = goog.iter.toIterator(iterable);

  // We maintain a cache to store the iterable elements as we iterate
  // over them. The cache is used to return elements once we have
  // iterated over the iterable once.
  var cache = [];
  var cacheIndex = 0;

  var iter = new goog.iter.Iterator();

  // This flag is set after the iterable is iterated over once
  var useCache = false;

  iter.next = function() {
    var returnElement = null;

    // Pull elements off the original iterator if not using cache
    if (!useCache) {
      try {
        // Return the element from the iterable
        returnElement = baseIterator.next();
        cache.push(returnElement);
        return returnElement;
      } catch (e) {
        // If an exception other than StopIteration is thrown
        // or if there are no elements to iterate over (the iterable was empty)
        // throw an exception
        if (e != goog.iter.StopIteration || goog.array.isEmpty(cache)) {
          throw e;
        }
        // set useCache to true after we know that a 'StopIteration' exception
        // was thrown and the cache is not empty (to handle the 'empty iterable'
        // use case)
        useCache = true;
      }
    }

    returnElement = cache[cacheIndex];
    cacheIndex = (cacheIndex + 1) % cache.length;

    return returnElement;
  };

  return iter;
};

// Copyright 2006 The Closure Library Authors. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS-IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * @fileoverview Generics method for collection-like classes and objects.
 *
 * @author arv@google.com (Erik Arvidsson)
 *
 * This file contains functions to work with collections. It supports using
 * Map, Set, Array and Object and other classes that implement collection-like
 * methods.
 */


goog.provide('goog.structs');

goog.require('goog.array');
goog.require('goog.object');


// We treat an object as a dictionary if it has getKeys or it is an object that
// isn't arrayLike.


/**
 * Returns the number of values in the collection-like object.
 * @param {Object} col The collection-like object.
 * @return {number} The number of values in the collection-like object.
 */
goog.structs.getCount = function(col) {
  if (typeof col.getCount == 'function') {
    return col.getCount();
  }
  if (goog.isArrayLike(col) || goog.isString(col)) {
    return col.length;
  }
  return goog.object.getCount(col);
};


/**
 * Returns the values of the collection-like object.
 * @param {Object} col The collection-like object.
 * @return {!Array} The values in the collection-like object.
 */
goog.structs.getValues = function(col) {
  if (typeof col.getValues == 'function') {
    return col.getValues();
  }
  if (goog.isString(col)) {
    return col.split('');
  }
  if (goog.isArrayLike(col)) {
    var rv = [];
    var l = col.length;
    for (var i = 0; i < l; i++) {
      rv.push(col[i]);
    }
    return rv;
  }
  return goog.object.getValues(col);
};


/**
 * Returns the keys of the collection. Some collections have no notion of
 * keys/indexes and this function will return undefined in those cases.
 * @param {Object} col The collection-like object.
 * @return {!Array|undefined} The keys in the collection.
 */
goog.structs.getKeys = function(col) {
  if (typeof col.getKeys == 'function') {
    return col.getKeys();
  }
  // if we have getValues but no getKeys we know this is a key-less collection
  if (typeof col.getValues == 'function') {
    return undefined;
  }
  if (goog.isArrayLike(col) || goog.isString(col)) {
    var rv = [];
    var l = col.length;
    for (var i = 0; i < l; i++) {
      rv.push(i);
    }
    return rv;
  }

  return goog.object.getKeys(col);
};


/**
 * Whether the collection contains the given value. This is O(n) and uses
 * equals (==) to test the existence.
 * @param {Object} col The collection-like object.
 * @param {*} val The value to check for.
 * @return {boolean} True if the map contains the value.
 */
goog.structs.contains = function(col, val) {
  if (typeof col.contains == 'function') {
    return col.contains(val);
  }
  if (typeof col.containsValue == 'function') {
    return col.containsValue(val);
  }
  if (goog.isArrayLike(col) || goog.isString(col)) {
    return goog.array.contains(/** @type {Array} */ (col), val);
  }
  return goog.object.containsValue(col, val);
};


/**
 * Whether the collection is empty.
 * @param {Object} col The collection-like object.
 * @return {boolean} True if empty.
 */
goog.structs.isEmpty = function(col) {
  if (typeof col.isEmpty == 'function') {
    return col.isEmpty();
  }

  // We do not use goog.string.isEmpty because here we treat the string as
  // collection and as such even whitespace matters

  if (goog.isArrayLike(col) || goog.isString(col)) {
    return goog.array.isEmpty(/** @type {Array} */ (col));
  }
  return goog.object.isEmpty(col);
};


/**
 * Removes all the elements from the collection.
 * @param {Object} col The collection-like object.
 */
goog.structs.clear = function(col) {
  // NOTE(arv): This should not contain strings because strings are immutable
  if (typeof col.clear == 'function') {
    col.clear();
  } else if (goog.isArrayLike(col)) {
    goog.array.clear(/** @type {goog.array.ArrayLike} */ (col));
  } else {
    goog.object.clear(col);
  }
};


/**
 * Calls a function for each value in a collection. The function takes
 * three arguments; the value, the key and the collection.
 *
 * @param {S} col The collection-like object.
 * @param {function(this:T,?,?,S):?} f The function to call for every value.
 *     This function takes
 *     3 arguments (the value, the key or undefined if the collection has no
 *     notion of keys, and the collection) and the return value is irrelevant.
 * @param {T=} opt_obj The object to be used as the value of 'this'
 *     within {@code f}.
 * @template T,S
 */
goog.structs.forEach = function(col, f, opt_obj) {
  if (typeof col.forEach == 'function') {
    col.forEach(f, opt_obj);
  } else if (goog.isArrayLike(col) || goog.isString(col)) {
    goog.array.forEach(/** @type {Array} */ (col), f, opt_obj);
  } else {
    var keys = goog.structs.getKeys(col);
    var values = goog.structs.getValues(col);
    var l = values.length;
    for (var i = 0; i < l; i++) {
      f.call(opt_obj, values[i], keys && keys[i], col);
    }
  }
};


/**
 * Calls a function for every value in the collection. When a call returns true,
 * adds the value to a new collection (Array is returned by default).
 *
 * @param {S} col The collection-like object.
 * @param {function(this:T,?,?,S):boolean} f The function to call for every
 *     value. This function takes
 *     3 arguments (the value, the key or undefined if the collection has no
 *     notion of keys, and the collection) and should return a Boolean. If the
 *     return value is true the value is added to the result collection. If it
 *     is false the value is not included.
 * @param {T=} opt_obj The object to be used as the value of 'this'
 *     within {@code f}.
 * @return {!Object|!Array} A new collection where the passed values are
 *     present. If col is a key-less collection an array is returned.  If col
 *     has keys and values a plain old JS object is returned.
 * @template T,S
 */
goog.structs.filter = function(col, f, opt_obj) {
  if (typeof col.filter == 'function') {
    return col.filter(f, opt_obj);
  }
  if (goog.isArrayLike(col) || goog.isString(col)) {
    return goog.array.filter(/** @type {!Array} */ (col), f, opt_obj);
  }

  var rv;
  var keys = goog.structs.getKeys(col);
  var values = goog.structs.getValues(col);
  var l = values.length;
  if (keys) {
    rv = {};
    for (var i = 0; i < l; i++) {
      if (f.call(opt_obj, values[i], keys[i], col)) {
        rv[keys[i]] = values[i];
      }
    }
  } else {
    // We should not use goog.array.filter here since we want to make sure that
    // the index is undefined as well as make sure that col is passed to the
    // function.
    rv = [];
    for (var i = 0; i < l; i++) {
      if (f.call(opt_obj, values[i], undefined, col)) {
        rv.push(values[i]);
      }
    }
  }
  return rv;
};


/**
 * Calls a function for every value in the collection and adds the result into a
 * new collection (defaults to creating a new Array).
 *
 * @param {S} col The collection-like object.
 * @param {function(this:T,?,?,S):V} f The function to call for every value.
 *     This function takes 3 arguments (the value, the key or undefined if the
 *     collection has no notion of keys, and the collection) and should return
 *     something. The result will be used as the value in the new collection.
 * @param {T=} opt_obj  The object to be used as the value of 'this'
 *     within {@code f}.
 * @return {!Object.<V>|!Array.<V>} A new collection with the new values.  If
 *     col is a key-less collection an array is returned.  If col has keys and
 *     values a plain old JS object is returned.
 * @template T,S,V
 */
goog.structs.map = function(col, f, opt_obj) {
  if (typeof col.map == 'function') {
    return col.map(f, opt_obj);
  }
  if (goog.isArrayLike(col) || goog.isString(col)) {
    return goog.array.map(/** @type {!Array} */ (col), f, opt_obj);
  }

  var rv;
  var keys = goog.structs.getKeys(col);
  var values = goog.structs.getValues(col);
  var l = values.length;
  if (keys) {
    rv = {};
    for (var i = 0; i < l; i++) {
      rv[keys[i]] = f.call(opt_obj, values[i], keys[i], col);
    }
  } else {
    // We should not use goog.array.map here since we want to make sure that
    // the index is undefined as well as make sure that col is passed to the
    // function.
    rv = [];
    for (var i = 0; i < l; i++) {
      rv[i] = f.call(opt_obj, values[i], undefined, col);
    }
  }
  return rv;
};


/**
 * Calls f for each value in a collection. If any call returns true this returns
 * true (without checking the rest). If all returns false this returns false.
 *
 * @param {S} col The collection-like object.
 * @param {function(this:T,?,?,S):boolean} f The function to call for every
 *     value. This function takes 3 arguments (the value, the key or undefined
 *     if the collection has no notion of keys, and the collection) and should
 *     return a boolean.
 * @param {T=} opt_obj  The object to be used as the value of 'this'
 *     within {@code f}.
 * @return {boolean} True if any value passes the test.
 * @template T,S
 */
goog.structs.some = function(col, f, opt_obj) {
  if (typeof col.some == 'function') {
    return col.some(f, opt_obj);
  }
  if (goog.isArrayLike(col) || goog.isString(col)) {
    return goog.array.some(/** @type {!Array} */ (col), f, opt_obj);
  }
  var keys = goog.structs.getKeys(col);
  var values = goog.structs.getValues(col);
  var l = values.length;
  for (var i = 0; i < l; i++) {
    if (f.call(opt_obj, values[i], keys && keys[i], col)) {
      return true;
    }
  }
  return false;
};


/**
 * Calls f for each value in a collection. If all calls return true this return
 * true this returns true. If any returns false this returns false at this point
 *  and does not continue to check the remaining values.
 *
 * @param {S} col The collection-like object.
 * @param {function(this:T,?,?,S):boolean} f The function to call for every
 *     value. This function takes 3 arguments (the value, the key or
 *     undefined if the collection has no notion of keys, and the collection)
 *     and should return a boolean.
 * @param {T=} opt_obj  The object to be used as the value of 'this'
 *     within {@code f}.
 * @return {boolean} True if all key-value pairs pass the test.
 * @template T,S
 */
goog.structs.every = function(col, f, opt_obj) {
  if (typeof col.every == 'function') {
    return col.every(f, opt_obj);
  }
  if (goog.isArrayLike(col) || goog.isString(col)) {
    return goog.array.every(/** @type {!Array} */ (col), f, opt_obj);
  }
  var keys = goog.structs.getKeys(col);
  var values = goog.structs.getValues(col);
  var l = values.length;
  for (var i = 0; i < l; i++) {
    if (!f.call(opt_obj, values[i], keys && keys[i], col)) {
      return false;
    }
  }
  return true;
};

// Copyright 2011 The Closure Library Authors. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS-IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * @fileoverview Defines the collection interface.
 *
 * @author nnaze@google.com (Nathan Naze)
 */

goog.provide('goog.structs.Collection');



/**
 * An interface for a collection of values.
 * @interface
 */
goog.structs.Collection = function() {};


/**
 * @param {*} value Value to add to the collection.
 */
goog.structs.Collection.prototype.add;


/**
 * @param {*} value Value to remove from the collection.
 */
goog.structs.Collection.prototype.remove;


/**
 * @param {*} value Value to find in the tree.
 * @return {boolean} Whether the collection contains the specified value.
 */
goog.structs.Collection.prototype.contains;


/**
 * @return {number} The number of values stored in the collection.
 */
goog.structs.Collection.prototype.getCount;


// Copyright 2006 The Closure Library Authors. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS-IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * @fileoverview Generic immutable node object to be used in collections.
 *
 */


goog.provide('goog.structs.Node');



/**
 * A generic immutable node. This can be used in various collections that
 * require a node object for its item (such as a heap).
 * @param {*} key Key.
 * @param {*} value Vaue.
 * @constructor
 */
goog.structs.Node = function(key, value) {
  /**
   * The key.
   * @type {*}
   * @private
   */
  this.key_ = key;

  /**
   * The value.
   * @type {*}
   * @private
   */
  this.value_ = value;
};


/**
 * Gets the key.
 * @return {*} The key.
 */
goog.structs.Node.prototype.getKey = function() {
  return this.key_;
};


/**
 * Gets the value.
 * @return {*} The value.
 */
goog.structs.Node.prototype.getValue = function() {
  return this.value_;
};


/**
 * Clones a node and returns a new node.
 * @return {goog.structs.Node} A new goog.structs.Node with the same key value
 *     pair.
 */
goog.structs.Node.prototype.clone = function() {
  return new goog.structs.Node(this.key_, this.value_);
};

// Copyright 2006 The Closure Library Authors. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS-IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * @fileoverview Datastructure: Heap.
 *
 *
 * This file provides the implementation of a Heap datastructure. Smaller keys
 * rise to the top.
 *
 * The big-O notation for all operations are below:
 * <pre>
 *  Method          big-O
 * ----------------------------------------------------------------------------
 * - insert         O(logn)
 * - remove         O(logn)
 * - peek           O(1)
 * - contains       O(n)
 * </pre>
 */
// TODO(user): Should this rely on natural ordering via some Comparable
//     interface?


goog.provide('goog.structs.Heap');

goog.require('goog.array');
goog.require('goog.object');
goog.require('goog.structs.Node');



/**
 * Class for a Heap datastructure.
 *
 * @param {goog.structs.Heap|Object=} opt_heap Optional goog.structs.Heap or
 *     Object to initialize heap with.
 * @constructor
 */
goog.structs.Heap = function(opt_heap) {
  /**
   * The nodes of the heap.
   * @private
   * @type {Array.<goog.structs.Node>}
   */
  this.nodes_ = [];

  if (opt_heap) {
    this.insertAll(opt_heap);
  }
};


/**
 * Insert the given value into the heap with the given key.
 * @param {*} key The key.
 * @param {*} value The value.
 */
goog.structs.Heap.prototype.insert = function(key, value) {
  var node = new goog.structs.Node(key, value);
  var nodes = this.nodes_;
  nodes.push(node);
  this.moveUp_(nodes.length - 1);
};


/**
 * Adds multiple key-value pairs from another goog.structs.Heap or Object
 * @param {goog.structs.Heap|Object} heap Object containing the data to add.
 */
goog.structs.Heap.prototype.insertAll = function(heap) {
  var keys, values;
  if (heap instanceof goog.structs.Heap) {
    keys = heap.getKeys();
    values = heap.getValues();

    // If it is a heap and the current heap is empty, I can realy on the fact
    // that the keys/values are in the correct order to put in the underlying
    // structure.
    if (heap.getCount() <= 0) {
      var nodes = this.nodes_;
      for (var i = 0; i < keys.length; i++) {
        nodes.push(new goog.structs.Node(keys[i], values[i]));
      }
      return;
    }
  } else {
    keys = goog.object.getKeys(heap);
    values = goog.object.getValues(heap);
  }

  for (var i = 0; i < keys.length; i++) {
    this.insert(keys[i], values[i]);
  }
};


/**
 * Retrieves and removes the root value of this heap.
 * @return {*} The value removed from the root of the heap.  Returns
 *     undefined if the heap is empty.
 */
goog.structs.Heap.prototype.remove = function() {
  var nodes = this.nodes_;
  var count = nodes.length;
  var rootNode = nodes[0];
  if (count <= 0) {
    return undefined;
  } else if (count == 1) {
    goog.array.clear(nodes);
  } else {
    nodes[0] = nodes.pop();
    this.moveDown_(0);
  }
  return rootNode.getValue();
};


/**
 * Retrieves but does not remove the root value of this heap.
 * @return {*} The value at the root of the heap. Returns
 *     undefined if the heap is empty.
 */
goog.structs.Heap.prototype.peek = function() {
  var nodes = this.nodes_;
  if (nodes.length == 0) {
    return undefined;
  }
  return nodes[0].getValue();
};


/**
 * Retrieves but does not remove the key of the root node of this heap.
 * @return {*} The key at the root of the heap. Returns undefined if the
 *     heap is empty.
 */
goog.structs.Heap.prototype.peekKey = function() {
  return this.nodes_[0] && this.nodes_[0].getKey();
};


/**
 * Moves the node at the given index down to its proper place in the heap.
 * @param {number} index The index of the node to move down.
 * @private
 */
goog.structs.Heap.prototype.moveDown_ = function(index) {
  var nodes = this.nodes_;
  var count = nodes.length;

  // Save the node being moved down.
  var node = nodes[index];
  // While the current node has a child.
  while (index < (count >> 1)) {
    var leftChildIndex = this.getLeftChildIndex_(index);
    var rightChildIndex = this.getRightChildIndex_(index);

    // Determine the index of the smaller child.
    var smallerChildIndex = rightChildIndex < count &&
        nodes[rightChildIndex].getKey() < nodes[leftChildIndex].getKey() ?
        rightChildIndex : leftChildIndex;

    // If the node being moved down is smaller than its children, the node
    // has found the correct index it should be at.
    if (nodes[smallerChildIndex].getKey() > node.getKey()) {
      break;
    }

    // If not, then take the smaller child as the current node.
    nodes[index] = nodes[smallerChildIndex];
    index = smallerChildIndex;
  }
  nodes[index] = node;
};


/**
 * Moves the node at the given index up to its proper place in the heap.
 * @param {number} index The index of the node to move up.
 * @private
 */
goog.structs.Heap.prototype.moveUp_ = function(index) {
  var nodes = this.nodes_;
  var node = nodes[index];

  // While the node being moved up is not at the root.
  while (index > 0) {
    // If the parent is less than the node being moved up, move the parent down.
    var parentIndex = this.getParentIndex_(index);
    if (nodes[parentIndex].getKey() > node.getKey()) {
      nodes[index] = nodes[parentIndex];
      index = parentIndex;
    } else {
      break;
    }
  }
  nodes[index] = node;
};


/**
 * Gets the index of the left child of the node at the given index.
 * @param {number} index The index of the node to get the left child for.
 * @return {number} The index of the left child.
 * @private
 */
goog.structs.Heap.prototype.getLeftChildIndex_ = function(index) {
  return index * 2 + 1;
};


/**
 * Gets the index of the right child of the node at the given index.
 * @param {number} index The index of the node to get the right child for.
 * @return {number} The index of the right child.
 * @private
 */
goog.structs.Heap.prototype.getRightChildIndex_ = function(index) {
  return index * 2 + 2;
};


/**
 * Gets the index of the parent of the node at the given index.
 * @param {number} index The index of the node to get the parent for.
 * @return {number} The index of the parent.
 * @private
 */
goog.structs.Heap.prototype.getParentIndex_ = function(index) {
  return (index - 1) >> 1;
};


/**
 * Gets the values of the heap.
 * @return {Array} The values in the heap.
 */
goog.structs.Heap.prototype.getValues = function() {
  var nodes = this.nodes_;
  var rv = [];
  var l = nodes.length;
  for (var i = 0; i < l; i++) {
    rv.push(nodes[i].getValue());
  }
  return rv;
};


/**
 * Gets the keys of the heap.
 * @return {Array} The keys in the heap.
 */
goog.structs.Heap.prototype.getKeys = function() {
  var nodes = this.nodes_;
  var rv = [];
  var l = nodes.length;
  for (var i = 0; i < l; i++) {
    rv.push(nodes[i].getKey());
  }
  return rv;
};


/**
 * Whether the heap contains the given value.
 * @param {Object} val The value to check for.
 * @return {boolean} Whether the heap contains the value.
 */
goog.structs.Heap.prototype.containsValue = function(val) {
  return goog.array.some(this.nodes_, function(node) {
    return node.getValue() == val;
  });
};


/**
 * Whether the heap contains the given key.
 * @param {Object} key The key to check for.
 * @return {boolean} Whether the heap contains the key.
 */
goog.structs.Heap.prototype.containsKey = function(key) {
  return goog.array.some(this.nodes_, function(node) {
    return node.getKey() == key;
  });
};


/**
 * Clones a heap and returns a new heap
 * @return {goog.structs.Heap} A new goog.structs.Heap with the same key-value
 *     pairs.
 */
goog.structs.Heap.prototype.clone = function() {
  return new goog.structs.Heap(this);
};


/**
 * The number of key-value pairs in the map
 * @return {number} The number of pairs.
 */
goog.structs.Heap.prototype.getCount = function() {
  return this.nodes_.length;
};


/**
 * Returns true if this heap contains no elements.
 * @return {boolean} Whether this heap contains no elements.
 */
goog.structs.Heap.prototype.isEmpty = function() {
  return goog.array.isEmpty(this.nodes_);
};


/**
 * Removes all elements from the heap.
 */
goog.structs.Heap.prototype.clear = function() {
  goog.array.clear(this.nodes_);
};

// Copyright 2006 The Closure Library Authors. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS-IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * @fileoverview Datastructure: Queue.
 *
 *
 * This file provides the implementation of a FIFO Queue structure.
 * API is similar to that of com.google.common.collect.IntQueue
 */

goog.provide('goog.structs.Queue');

goog.require('goog.array');



/**
 * Class for FIFO Queue data structure.
 *
 * @constructor
 */
goog.structs.Queue = function() {
  this.elements_ = [];
};


/**
 * The index of the next element to be removed from the queue.
 * @private
 * @type {number}
 */
goog.structs.Queue.prototype.head_ = 0;


/**
 * The index at which the next element would be added to the queue.
 * @private
 * @type {number}
 */
goog.structs.Queue.prototype.tail_ = 0;


/**
 * Puts the specified element on this queue.
 * @param {*} element The element to be added to the queue.
 */
goog.structs.Queue.prototype.enqueue = function(element) {
  this.elements_[this.tail_++] = element;
};


/**
 * Retrieves and removes the head of this queue.
 * @return {*} The element at the head of this queue. Returns undefined if the
 *     queue is empty.
 */
goog.structs.Queue.prototype.dequeue = function() {
  if (this.head_ == this.tail_) {
    return undefined;
  }
  var result = this.elements_[this.head_];
  delete this.elements_[this.head_];
  this.head_++;
  return result;
};


/**
 * Retrieves but does not remove the head of this queue.
 * @return {*} The element at the head of this queue. Returns undefined if the
 *     queue is empty.
 */
goog.structs.Queue.prototype.peek = function() {
  if (this.head_ == this.tail_) {
    return undefined;
  }
  return this.elements_[this.head_];
};


/**
 * Returns the number of elements in this queue.
 * @return {number} The number of elements in this queue.
 */
goog.structs.Queue.prototype.getCount = function() {
  return this.tail_ - this.head_;
};


/**
 * Returns true if this queue contains no elements.
 * @return {boolean} true if this queue contains no elements.
 */
goog.structs.Queue.prototype.isEmpty = function() {
  return this.tail_ - this.head_ == 0;
};


/**
 * Removes all elements from the queue.
 */
goog.structs.Queue.prototype.clear = function() {
  this.elements_.length = 0;
  this.head_ = 0;
  this.tail_ = 0;
};


/**
 * Returns true if the given value is in the queue.
 * @param {*} obj The value to look for.
 * @return {boolean} Whether the object is in the queue.
 */
goog.structs.Queue.prototype.contains = function(obj) {
  return goog.array.contains(this.elements_, obj);
};


/**
 * Removes the first occurrence of a particular value from the queue.
 * @param {*} obj Object to remove.
 * @return {boolean} True if an element was removed.
 */
goog.structs.Queue.prototype.remove = function(obj) {
  var index = goog.array.indexOf(this.elements_, obj);
  if (index < 0) {
    return false;
  }
  if (index == this.head_) {
    this.dequeue();
  } else {
    goog.array.removeAt(this.elements_, index);
    this.tail_--;
  }
  return true;
};


/**
 * Returns all the values in the queue.
 * @return {Array} An array of the values in the queue.
 */
goog.structs.Queue.prototype.getValues = function() {
  return this.elements_.slice(this.head_, this.tail_);
};

// Copyright 2006 The Closure Library Authors. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS-IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * @fileoverview Datastructure: Hash Map.
 *
 * @author arv@google.com (Erik Arvidsson)
 * @author jonp@google.com (Jon Perlow) Optimized for IE6
 *
 * This file contains an implementation of a Map structure. It implements a lot
 * of the methods used in goog.structs so those functions work on hashes.  For
 * convenience with common usage the methods accept any type for the key, though
 * internally they will be cast to strings.
 */


goog.provide('goog.structs.Map');

goog.require('goog.iter.Iterator');
goog.require('goog.iter.StopIteration');
goog.require('goog.object');
goog.require('goog.structs');



/**
 * Class for Hash Map datastructure.
 * @param {*=} opt_map Map or Object to initialize the map with.
 * @param {...*} var_args If 2 or more arguments are present then they
 *     will be used as key-value pairs.
 * @constructor
 */
goog.structs.Map = function(opt_map, var_args) {

  /**
   * Underlying JS object used to implement the map.
   * @type {!Object}
   * @private
   */
  this.map_ = {};

  /**
   * An array of keys. This is necessary for two reasons:
   *   1. Iterating the keys using for (var key in this.map_) allocates an
   *      object for every key in IE which is really bad for IE6 GC perf.
   *   2. Without a side data structure, we would need to escape all the keys
   *      as that would be the only way we could tell during iteration if the
   *      key was an internal key or a property of the object.
   *
   * This array can contain deleted keys so it's necessary to check the map
   * as well to see if the key is still in the map (this doesn't require a
   * memory allocation in IE).
   * @type {!Array.<string>}
   * @private
   */
  this.keys_ = [];

  var argLength = arguments.length;

  if (argLength > 1) {
    if (argLength % 2) {
      throw Error('Uneven number of arguments');
    }
    for (var i = 0; i < argLength; i += 2) {
      this.set(arguments[i], arguments[i + 1]);
    }
  } else if (opt_map) {
    this.addAll(/** @type {Object} */ (opt_map));
  }
};


/**
 * The number of key value pairs in the map.
 * @private
 * @type {number}
 */
goog.structs.Map.prototype.count_ = 0;


/**
 * Version used to detect changes while iterating.
 * @private
 * @type {number}
 */
goog.structs.Map.prototype.version_ = 0;


/**
 * @return {number} The number of key-value pairs in the map.
 */
goog.structs.Map.prototype.getCount = function() {
  return this.count_;
};


/**
 * Returns the values of the map.
 * @return {!Array} The values in the map.
 */
goog.structs.Map.prototype.getValues = function() {
  this.cleanupKeysArray_();

  var rv = [];
  for (var i = 0; i < this.keys_.length; i++) {
    var key = this.keys_[i];
    rv.push(this.map_[key]);
  }
  return rv;
};


/**
 * Returns the keys of the map.
 * @return {!Array.<string>} Array of string values.
 */
goog.structs.Map.prototype.getKeys = function() {
  this.cleanupKeysArray_();
  return /** @type {!Array.<string>} */ (this.keys_.concat());
};


/**
 * Whether the map contains the given key.
 * @param {*} key The key to check for.
 * @return {boolean} Whether the map contains the key.
 */
goog.structs.Map.prototype.containsKey = function(key) {
  return goog.structs.Map.hasKey_(this.map_, key);
};


/**
 * Whether the map contains the given value. This is O(n).
 * @param {*} val The value to check for.
 * @return {boolean} Whether the map contains the value.
 */
goog.structs.Map.prototype.containsValue = function(val) {
  for (var i = 0; i < this.keys_.length; i++) {
    var key = this.keys_[i];
    if (goog.structs.Map.hasKey_(this.map_, key) && this.map_[key] == val) {
      return true;
    }
  }
  return false;
};


/**
 * Whether this map is equal to the argument map.
 * @param {goog.structs.Map} otherMap The map against which to test equality.
 * @param {function(?, ?) : boolean=} opt_equalityFn Optional equality function
 *     to test equality of values. If not specified, this will test whether
 *     the values contained in each map are identical objects.
 * @return {boolean} Whether the maps are equal.
 */
goog.structs.Map.prototype.equals = function(otherMap, opt_equalityFn) {
  if (this === otherMap) {
    return true;
  }

  if (this.count_ != otherMap.getCount()) {
    return false;
  }

  var equalityFn = opt_equalityFn || goog.structs.Map.defaultEquals;

  this.cleanupKeysArray_();
  for (var key, i = 0; key = this.keys_[i]; i++) {
    if (!equalityFn(this.get(key), otherMap.get(key))) {
      return false;
    }
  }

  return true;
};


/**
 * Default equality test for values.
 * @param {*} a The first value.
 * @param {*} b The second value.
 * @return {boolean} Whether a and b reference the same object.
 */
goog.structs.Map.defaultEquals = function(a, b) {
  return a === b;
};


/**
 * @return {boolean} Whether the map is empty.
 */
goog.structs.Map.prototype.isEmpty = function() {
  return this.count_ == 0;
};


/**
 * Removes all key-value pairs from the map.
 */
goog.structs.Map.prototype.clear = function() {
  this.map_ = {};
  this.keys_.length = 0;
  this.count_ = 0;
  this.version_ = 0;
};


/**
 * Removes a key-value pair based on the key. This is O(logN) amortized due to
 * updating the keys array whenever the count becomes half the size of the keys
 * in the keys array.
 * @param {*} key  The key to remove.
 * @return {boolean} Whether object was removed.
 */
goog.structs.Map.prototype.remove = function(key) {
  if (goog.structs.Map.hasKey_(this.map_, key)) {
    delete this.map_[key];
    this.count_--;
    this.version_++;

    // clean up the keys array if the threshhold is hit
    if (this.keys_.length > 2 * this.count_) {
      this.cleanupKeysArray_();
    }

    return true;
  }
  return false;
};


/**
 * Cleans up the temp keys array by removing entries that are no longer in the
 * map.
 * @private
 */
goog.structs.Map.prototype.cleanupKeysArray_ = function() {
  if (this.count_ != this.keys_.length) {
    // First remove keys that are no longer in the map.
    var srcIndex = 0;
    var destIndex = 0;
    while (srcIndex < this.keys_.length) {
      var key = this.keys_[srcIndex];
      if (goog.structs.Map.hasKey_(this.map_, key)) {
        this.keys_[destIndex++] = key;
      }
      srcIndex++;
    }
    this.keys_.length = destIndex;
  }

  if (this.count_ != this.keys_.length) {
    // If the count still isn't correct, that means we have duplicates. This can
    // happen when the same key is added and removed multiple times. Now we have
    // to allocate one extra Object to remove the duplicates. This could have
    // been done in the first pass, but in the common case, we can avoid
    // allocating an extra object by only doing this when necessary.
    var seen = {};
    var srcIndex = 0;
    var destIndex = 0;
    while (srcIndex < this.keys_.length) {
      var key = this.keys_[srcIndex];
      if (!(goog.structs.Map.hasKey_(seen, key))) {
        this.keys_[destIndex++] = key;
        seen[key] = 1;
      }
      srcIndex++;
    }
    this.keys_.length = destIndex;
  }
};


/**
 * Returns the value for the given key.  If the key is not found and the default
 * value is not given this will return {@code undefined}.
 * @param {*} key The key to get the value for.
 * @param {*=} opt_val The value to return if no item is found for the given
 *     key, defaults to undefined.
 * @return {*} The value for the given key.
 */
goog.structs.Map.prototype.get = function(key, opt_val) {
  if (goog.structs.Map.hasKey_(this.map_, key)) {
    return this.map_[key];
  }
  return opt_val;
};


/**
 * Adds a key-value pair to the map.
 * @param {*} key The key.
 * @param {*} value The value to add.
 * @return {*} Some subclasses return a value.
 */
goog.structs.Map.prototype.set = function(key, value) {
  if (!(goog.structs.Map.hasKey_(this.map_, key))) {
    this.count_++;
    this.keys_.push(key);
    // Only change the version if we add a new key.
    this.version_++;
  }
  this.map_[key] = value;
};


/**
 * Adds multiple key-value pairs from another goog.structs.Map or Object.
 * @param {Object} map  Object containing the data to add.
 */
goog.structs.Map.prototype.addAll = function(map) {
  var keys, values;
  if (map instanceof goog.structs.Map) {
    keys = map.getKeys();
    values = map.getValues();
  } else {
    keys = goog.object.getKeys(map);
    values = goog.object.getValues(map);
  }
  // we could use goog.array.forEach here but I don't want to introduce that
  // dependency just for this.
  for (var i = 0; i < keys.length; i++) {
    this.set(keys[i], values[i]);
  }
};


/**
 * Clones a map and returns a new map.
 * @return {!goog.structs.Map} A new map with the same key-value pairs.
 */
goog.structs.Map.prototype.clone = function() {
  return new goog.structs.Map(this);
};


/**
 * Returns a new map in which all the keys and values are interchanged
 * (keys become values and values become keys). If multiple keys map to the
 * same value, the chosen transposed value is implementation-dependent.
 *
 * It acts very similarly to {goog.object.transpose(Object)}.
 *
 * @return {!goog.structs.Map} The transposed map.
 */
goog.structs.Map.prototype.transpose = function() {
  var transposed = new goog.structs.Map();
  for (var i = 0; i < this.keys_.length; i++) {
    var key = this.keys_[i];
    var value = this.map_[key];
    transposed.set(value, key);
  }

  return transposed;
};


/**
 * @return {!Object} Object representation of the map.
 */
goog.structs.Map.prototype.toObject = function() {
  this.cleanupKeysArray_();
  var obj = {};
  for (var i = 0; i < this.keys_.length; i++) {
    var key = this.keys_[i];
    obj[key] = this.map_[key];
  }
  return obj;
};


/**
 * Returns an iterator that iterates over the keys in the map.  Removal of keys
 * while iterating might have undesired side effects.
 * @return {!goog.iter.Iterator} An iterator over the keys in the map.
 */
goog.structs.Map.prototype.getKeyIterator = function() {
  return this.__iterator__(true);
};


/**
 * Returns an iterator that iterates over the values in the map.  Removal of
 * keys while iterating might have undesired side effects.
 * @return {!goog.iter.Iterator} An iterator over the values in the map.
 */
goog.structs.Map.prototype.getValueIterator = function() {
  return this.__iterator__(false);
};


/**
 * Returns an iterator that iterates over the values or the keys in the map.
 * This throws an exception if the map was mutated since the iterator was
 * created.
 * @param {boolean=} opt_keys True to iterate over the keys. False to iterate
 *     over the values.  The default value is false.
 * @return {!goog.iter.Iterator} An iterator over the values or keys in the map.
 */
goog.structs.Map.prototype.__iterator__ = function(opt_keys) {
  // Clean up keys to minimize the risk of iterating over dead keys.
  this.cleanupKeysArray_();

  var i = 0;
  var keys = this.keys_;
  var map = this.map_;
  var version = this.version_;
  var selfObj = this;

  var newIter = new goog.iter.Iterator;
  newIter.next = function() {
    while (true) {
      if (version != selfObj.version_) {
        throw Error('The map has changed since the iterator was created');
      }
      if (i >= keys.length) {
        throw goog.iter.StopIteration;
      }
      var key = keys[i++];
      return opt_keys ? key : map[key];
    }
  };
  return newIter;
};


/**
 * Safe way to test for hasOwnProperty.  It even allows testing for
 * 'hasOwnProperty'.
 * @param {Object} obj The object to test for presence of the given key.
 * @param {*} key The key to check for.
 * @return {boolean} Whether the object has the key.
 * @private
 */
goog.structs.Map.hasKey_ = function(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
};

// Copyright 2006 The Closure Library Authors. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS-IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * @fileoverview Datastructure: Set.
 *
 * @author arv@google.com (Erik Arvidsson)
 * @author pallosp@google.com (Peter Pallos)
 *
 * This class implements a set data structure. Adding and removing is O(1). It
 * supports both object and primitive values. Be careful because you can add
 * both 1 and new Number(1), because these are not the same. You can even add
 * multiple new Number(1) because these are not equal.
 */


goog.provide('goog.structs.Set');

goog.require('goog.structs');
goog.require('goog.structs.Collection');
goog.require('goog.structs.Map');



/**
 * A set that can contain both primitives and objects.  Adding and removing
 * elements is O(1).  Primitives are treated as identical if they have the same
 * type and convert to the same string.  Objects are treated as identical only
 * if they are references to the same object.  WARNING: A goog.structs.Set can
 * contain both 1 and (new Number(1)), because they are not the same.  WARNING:
 * Adding (new Number(1)) twice will yield two distinct elements, because they
 * are two different objects.  WARNING: Any object that is added to a
 * goog.structs.Set will be modified!  Because goog.getUid() is used to
 * identify objects, every object in the set will be mutated.
 * @param {Array|Object=} opt_values Initial values to start with.
 * @constructor
 * @implements {goog.structs.Collection}
 */
goog.structs.Set = function(opt_values) {
  this.map_ = new goog.structs.Map;
  if (opt_values) {
    this.addAll(opt_values);
  }
};


/**
 * Obtains a unique key for an element of the set.  Primitives will yield the
 * same key if they have the same type and convert to the same string.  Object
 * references will yield the same key only if they refer to the same object.
 * @param {*} val Object or primitive value to get a key for.
 * @return {string} A unique key for this value/object.
 * @private
 */
goog.structs.Set.getKey_ = function(val) {
  var type = typeof val;
  if (type == 'object' && val || type == 'function') {
    return 'o' + goog.getUid(/** @type {Object} */ (val));
  } else {
    return type.substr(0, 1) + val;
  }
};


/**
 * @return {number} The number of elements in the set.
 * @override
 */
goog.structs.Set.prototype.getCount = function() {
  return this.map_.getCount();
};


/**
 * Add a primitive or an object to the set.
 * @param {*} element The primitive or object to add.
 * @override
 */
goog.structs.Set.prototype.add = function(element) {
  this.map_.set(goog.structs.Set.getKey_(element), element);
};


/**
 * Adds all the values in the given collection to this set.
 * @param {Array|Object} col A collection containing the elements to add.
 */
goog.structs.Set.prototype.addAll = function(col) {
  var values = goog.structs.getValues(col);
  var l = values.length;
  for (var i = 0; i < l; i++) {
    this.add(values[i]);
  }
};


/**
 * Removes all values in the given collection from this set.
 * @param {Array|Object} col A collection containing the elements to remove.
 */
goog.structs.Set.prototype.removeAll = function(col) {
  var values = goog.structs.getValues(col);
  var l = values.length;
  for (var i = 0; i < l; i++) {
    this.remove(values[i]);
  }
};


/**
 * Removes the given element from this set.
 * @param {*} element The primitive or object to remove.
 * @return {boolean} Whether the element was found and removed.
 * @override
 */
goog.structs.Set.prototype.remove = function(element) {
  return this.map_.remove(goog.structs.Set.getKey_(element));
};


/**
 * Removes all elements from this set.
 */
goog.structs.Set.prototype.clear = function() {
  this.map_.clear();
};


/**
 * Tests whether this set is empty.
 * @return {boolean} True if there are no elements in this set.
 */
goog.structs.Set.prototype.isEmpty = function() {
  return this.map_.isEmpty();
};


/**
 * Tests whether this set contains the given element.
 * @param {*} element The primitive or object to test for.
 * @return {boolean} True if this set contains the given element.
 * @override
 */
goog.structs.Set.prototype.contains = function(element) {
  return this.map_.containsKey(goog.structs.Set.getKey_(element));
};


/**
 * Tests whether this set contains all the values in a given collection.
 * Repeated elements in the collection are ignored, e.g.  (new
 * goog.structs.Set([1, 2])).containsAll([1, 1]) is True.
 * @param {Object} col A collection-like object.
 * @return {boolean} True if the set contains all elements.
 */
goog.structs.Set.prototype.containsAll = function(col) {
  return goog.structs.every(col, this.contains, this);
};


/**
 * Finds all values that are present in both this set and the given collection.
 * @param {Array|Object} col A collection.
 * @return {!goog.structs.Set} A new set containing all the values (primitives
 *     or objects) present in both this set and the given collection.
 */
goog.structs.Set.prototype.intersection = function(col) {
  var result = new goog.structs.Set();

  var values = goog.structs.getValues(col);
  for (var i = 0; i < values.length; i++) {
    var value = values[i];
    if (this.contains(value)) {
      result.add(value);
    }
  }

  return result;
};


/**
 * Finds all values that are present in this set and not in the given
 * collection.
 * @param {Array|Object} col A collection.
 * @return {!goog.structs.Set} A new set containing all the values
 *     (primitives or objects) present in this set but not in the given
 *     collection.
 */
goog.structs.Set.prototype.difference = function(col) {
  var result = this.clone();
  result.removeAll(col);
  return result;
};


/**
 * Returns an array containing all the elements in this set.
 * @return {!Array} An array containing all the elements in this set.
 */
goog.structs.Set.prototype.getValues = function() {
  return this.map_.getValues();
};


/**
 * Creates a shallow clone of this set.
 * @return {!goog.structs.Set} A new set containing all the same elements as
 *     this set.
 */
goog.structs.Set.prototype.clone = function() {
  return new goog.structs.Set(this);
};


/**
 * Tests whether the given collection consists of the same elements as this set,
 * regardless of order, without repetition.  Primitives are treated as equal if
 * they have the same type and convert to the same string; objects are treated
 * as equal if they are references to the same object.  This operation is O(n).
 * @param {Object} col A collection.
 * @return {boolean} True if the given collection consists of the same elements
 *     as this set, regardless of order, without repetition.
 */
goog.structs.Set.prototype.equals = function(col) {
  return this.getCount() == goog.structs.getCount(col) && this.isSubsetOf(col);
};


/**
 * Tests whether the given collection contains all the elements in this set.
 * Primitives are treated as equal if they have the same type and convert to the
 * same string; objects are treated as equal if they are references to the same
 * object.  This operation is O(n).
 * @param {Object} col A collection.
 * @return {boolean} True if this set is a subset of the given collection.
 */
goog.structs.Set.prototype.isSubsetOf = function(col) {
  var colCount = goog.structs.getCount(col);
  if (this.getCount() > colCount) {
    return false;
  }
  // TODO(user) Find the minimal collection size where the conversion makes
  // the contains() method faster.
  if (!(col instanceof goog.structs.Set) && colCount > 5) {
    // Convert to a goog.structs.Set so that goog.structs.contains runs in
    // O(1) time instead of O(n) time.
    col = new goog.structs.Set(col);
  }
  return goog.structs.every(this, function(value) {
    return goog.structs.contains(col, value);
  });
};


/**
 * Returns an iterator that iterates over the elements in this set.
 * @param {boolean=} opt_keys This argument is ignored.
 * @return {!goog.iter.Iterator} An iterator over the elements in this set.
 */
goog.structs.Set.prototype.__iterator__ = function(opt_keys) {
  return this.map_.__iterator__(false);
};

// Copyright (c) 2005  Tom Wu
// All Rights Reserved.
// See "LICENSE" for details.

// Basic JavaScript BN library - subset useful for RSA encryption.

// Bits per digit
var dbits;

// JavaScript engine analysis
var canary = 0xdeadbeefcafe;
var j_lm = ((canary&0xffffff)==0xefcafe);

// (public) Constructor
function BigInteger(a,b,c) {
  this.data = [];
  if(a != null)
    if("number" == typeof a) this.fromNumber(a,b,c);
    else if(b == null && "string" != typeof a) this.fromString(a,256);
    else this.fromString(a,b);
}

// return new, unset BigInteger
function nbi() { return new BigInteger(null); }

// am: Compute w_j += (x*this_i), propagate carries,
// c is initial carry, returns final carry.
// c < 3*dvalue, x < 2*dvalue, this_i < dvalue
// We need to select the fastest one that works in this environment.

// am1: use a single mult and divide to get the high bits,
// max digit bits should be 26 because
// max internal value = 2*dvalue^2-2*dvalue (< 2^53)
function am1(i,x,w,j,c,n) {
  while(--n >= 0) {
    var v = x*this.data[i++]+w.data[j]+c;
    c = Math.floor(v/0x4000000);
    w.data[j++] = v&0x3ffffff;
  }
  return c;
}
// am2 avoids a big mult-and-extract completely.
// Max digit bits should be <= 30 because we do bitwise ops
// on values up to 2*hdvalue^2-hdvalue-1 (< 2^31)
function am2(i,x,w,j,c,n) {
  var xl = x&0x7fff, xh = x>>15;
  while(--n >= 0) {
    var l = this.data[i]&0x7fff;
    var h = this.data[i++]>>15;
    var m = xh*l+h*xl;
    l = xl*l+((m&0x7fff)<<15)+w.data[j]+(c&0x3fffffff);
    c = (l>>>30)+(m>>>15)+xh*h+(c>>>30);
    w.data[j++] = l&0x3fffffff;
  }
  return c;
}
// Alternately, set max digit bits to 28 since some
// browsers slow down when dealing with 32-bit numbers.
function am3(i,x,w,j,c,n) {
  var xl = x&0x3fff, xh = x>>14;
  while(--n >= 0) {
    var l = this.data[i]&0x3fff;
    var h = this.data[i++]>>14;
    var m = xh*l+h*xl;
    l = xl*l+((m&0x3fff)<<14)+w.data[j]+c;
    c = (l>>28)+(m>>14)+xh*h;
    w.data[j++] = l&0xfffffff;
  }
  return c;
}

// node.js (no browser)
if(typeof(navigator) === 'undefined')
{
   BigInteger.prototype.am = am3;
   dbits = 28;
}
else if(j_lm && (navigator.appName == "Microsoft Internet Explorer")) {
  BigInteger.prototype.am = am2;
  dbits = 30;
}
else if(j_lm && (navigator.appName != "Netscape")) {
  BigInteger.prototype.am = am1;
  dbits = 26;
}
else { // Mozilla/Netscape seems to prefer am3
  BigInteger.prototype.am = am3;
  dbits = 28;
}

BigInteger.prototype.DB = dbits;
BigInteger.prototype.DM = ((1<<dbits)-1);
BigInteger.prototype.DV = (1<<dbits);

var BI_FP = 52;
BigInteger.prototype.FV = Math.pow(2,BI_FP);
BigInteger.prototype.F1 = BI_FP-dbits;
BigInteger.prototype.F2 = 2*dbits-BI_FP;

// Digit conversions
var BI_RM = "0123456789abcdefghijklmnopqrstuvwxyz";
var BI_RC = new Array();
var rr,vv;
rr = "0".charCodeAt(0);
for(vv = 0; vv <= 9; ++vv) BI_RC[rr++] = vv;
rr = "a".charCodeAt(0);
for(vv = 10; vv < 36; ++vv) BI_RC[rr++] = vv;
rr = "A".charCodeAt(0);
for(vv = 10; vv < 36; ++vv) BI_RC[rr++] = vv;

function int2char(n) { return BI_RM.charAt(n); }
function intAt(s,i) {
  var c = BI_RC[s.charCodeAt(i)];
  return (c==null)?-1:c;
}

// (protected) copy this to r
function bnpCopyTo(r) {
  for(var i = this.t-1; i >= 0; --i) r.data[i] = this.data[i];
  r.t = this.t;
  r.s = this.s;
}

// (protected) set from integer value x, -DV <= x < DV
function bnpFromInt(x) {
  this.t = 1;
  this.s = (x<0)?-1:0;
  if(x > 0) this.data[0] = x;
  else if(x < -1) this.data[0] = x+DV;
  else this.t = 0;
}

// return bigint initialized to value
function nbv(i) { var r = nbi(); r.fromInt(i); return r; }

// (protected) set from string and radix
function bnpFromString(s,b) {
  var k;
  if(b == 16) k = 4;
  else if(b == 8) k = 3;
  else if(b == 256) k = 8; // byte array
  else if(b == 2) k = 1;
  else if(b == 32) k = 5;
  else if(b == 4) k = 2;
  else { this.fromRadix(s,b); return; }
  this.t = 0;
  this.s = 0;
  var i = s.length, mi = false, sh = 0;
  while(--i >= 0) {
    var x = (k==8)?s[i]&0xff:intAt(s,i);
    if(x < 0) {
      if(s.charAt(i) == "-") mi = true;
      continue;
    }
    mi = false;
    if(sh == 0)
      this.data[this.t++] = x;
    else if(sh+k > this.DB) {
      this.data[this.t-1] |= (x&((1<<(this.DB-sh))-1))<<sh;
      this.data[this.t++] = (x>>(this.DB-sh));
    }
    else
      this.data[this.t-1] |= x<<sh;
    sh += k;
    if(sh >= this.DB) sh -= this.DB;
  }
  if(k == 8 && (s[0]&0x80) != 0) {
    this.s = -1;
    if(sh > 0) this.data[this.t-1] |= ((1<<(this.DB-sh))-1)<<sh;
  }
  this.clamp();
  if(mi) BigInteger.ZERO.subTo(this,this);
}

// (protected) clamp off excess high words
function bnpClamp() {
  var c = this.s&this.DM;
  while(this.t > 0 && this.data[this.t-1] == c) --this.t;
}

// (public) return string representation in given radix
function bnToString(b) {
  if(this.s < 0) return "-"+this.negate().toString(b);
  var k;
  if(b == 16) k = 4;
  else if(b == 8) k = 3;
  else if(b == 2) k = 1;
  else if(b == 32) k = 5;
  else if(b == 4) k = 2;
  else return this.toRadix(b);
  var km = (1<<k)-1, d, m = false, r = "", i = this.t;
  var p = this.DB-(i*this.DB)%k;
  if(i-- > 0) {
    if(p < this.DB && (d = this.data[i]>>p) > 0) { m = true; r = int2char(d); }
    while(i >= 0) {
      if(p < k) {
        d = (this.data[i]&((1<<p)-1))<<(k-p);
        d |= this.data[--i]>>(p+=this.DB-k);
      }
      else {
        d = (this.data[i]>>(p-=k))&km;
        if(p <= 0) { p += this.DB; --i; }
      }
      if(d > 0) m = true;
      if(m) r += int2char(d);
    }
  }
  return m?r:"0";
}

// (public) -this
function bnNegate() { var r = nbi(); BigInteger.ZERO.subTo(this,r); return r; }

// (public) |this|
function bnAbs() { return (this.s<0)?this.negate():this; }

// (public) return + if this > a, - if this < a, 0 if equal
function bnCompareTo(a) {
  var r = this.s-a.s;
  if(r != 0) return r;
  var i = this.t;
  r = i-a.t;
  if(r != 0) return (this.s<0)?-r:r;
  while(--i >= 0) if((r=this.data[i]-a.data[i]) != 0) return r;
  return 0;
}

// returns bit length of the integer x
function nbits(x) {
  var r = 1, t;
  if((t=x>>>16) != 0) { x = t; r += 16; }
  if((t=x>>8) != 0) { x = t; r += 8; }
  if((t=x>>4) != 0) { x = t; r += 4; }
  if((t=x>>2) != 0) { x = t; r += 2; }
  if((t=x>>1) != 0) { x = t; r += 1; }
  return r;
}

// (public) return the number of bits in "this"
function bnBitLength() {
  if(this.t <= 0) return 0;
  return this.DB*(this.t-1)+nbits(this.data[this.t-1]^(this.s&this.DM));
}

// (protected) r = this << n*DB
function bnpDLShiftTo(n,r) {
  var i;
  for(i = this.t-1; i >= 0; --i) r.data[i+n] = this.data[i];
  for(i = n-1; i >= 0; --i) r.data[i] = 0;
  r.t = this.t+n;
  r.s = this.s;
}

// (protected) r = this >> n*DB
function bnpDRShiftTo(n,r) {
  for(var i = n; i < this.t; ++i) r.data[i-n] = this.data[i];
  r.t = Math.max(this.t-n,0);
  r.s = this.s;
}

// (protected) r = this << n
function bnpLShiftTo(n,r) {
  var bs = n%this.DB;
  var cbs = this.DB-bs;
  var bm = (1<<cbs)-1;
  var ds = Math.floor(n/this.DB), c = (this.s<<bs)&this.DM, i;
  for(i = this.t-1; i >= 0; --i) {
    r.data[i+ds+1] = (this.data[i]>>cbs)|c;
    c = (this.data[i]&bm)<<bs;
  }
  for(i = ds-1; i >= 0; --i) r.data[i] = 0;
  r.data[ds] = c;
  r.t = this.t+ds+1;
  r.s = this.s;
  r.clamp();
}

// (protected) r = this >> n
function bnpRShiftTo(n,r) {
  r.s = this.s;
  var ds = Math.floor(n/this.DB);
  if(ds >= this.t) { r.t = 0; return; }
  var bs = n%this.DB;
  var cbs = this.DB-bs;
  var bm = (1<<bs)-1;
  r.data[0] = this.data[ds]>>bs;
  for(var i = ds+1; i < this.t; ++i) {
    r.data[i-ds-1] |= (this.data[i]&bm)<<cbs;
    r.data[i-ds] = this.data[i]>>bs;
  }
  if(bs > 0) r.data[this.t-ds-1] |= (this.s&bm)<<cbs;
  r.t = this.t-ds;
  r.clamp();
}

// (protected) r = this - a
function bnpSubTo(a,r) {
  var i = 0, c = 0, m = Math.min(a.t,this.t);
  while(i < m) {
    c += this.data[i]-a.data[i];
    r.data[i++] = c&this.DM;
    c >>= this.DB;
  }
  if(a.t < this.t) {
    c -= a.s;
    while(i < this.t) {
      c += this.data[i];
      r.data[i++] = c&this.DM;
      c >>= this.DB;
    }
    c += this.s;
  }
  else {
    c += this.s;
    while(i < a.t) {
      c -= a.data[i];
      r.data[i++] = c&this.DM;
      c >>= this.DB;
    }
    c -= a.s;
  }
  r.s = (c<0)?-1:0;
  if(c < -1) r.data[i++] = this.DV+c;
  else if(c > 0) r.data[i++] = c;
  r.t = i;
  r.clamp();
}

// (protected) r = this * a, r != this,a (HAC 14.12)
// "this" should be the larger one if appropriate.
function bnpMultiplyTo(a,r) {
  var x = this.abs(), y = a.abs();
  var i = x.t;
  r.t = i+y.t;
  while(--i >= 0) r.data[i] = 0;
  for(i = 0; i < y.t; ++i) r.data[i+x.t] = x.am(0,y.data[i],r,i,0,x.t);
  r.s = 0;
  r.clamp();
  if(this.s != a.s) BigInteger.ZERO.subTo(r,r);
}

// (protected) r = this^2, r != this (HAC 14.16)
function bnpSquareTo(r) {
  var x = this.abs();
  var i = r.t = 2*x.t;
  while(--i >= 0) r.data[i] = 0;
  for(i = 0; i < x.t-1; ++i) {
    var c = x.am(i,x.data[i],r,2*i,0,1);
    if((r.data[i+x.t]+=x.am(i+1,2*x.data[i],r,2*i+1,c,x.t-i-1)) >= x.DV) {
      r.data[i+x.t] -= x.DV;
      r.data[i+x.t+1] = 1;
    }
  }
  if(r.t > 0) r.data[r.t-1] += x.am(i,x.data[i],r,2*i,0,1);
  r.s = 0;
  r.clamp();
}

// (protected) divide this by m, quotient and remainder to q, r (HAC 14.20)
// r != q, this != m.  q or r may be null.
function bnpDivRemTo(m,q,r) {
  var pm = m.abs();
  if(pm.t <= 0) return;
  var pt = this.abs();
  if(pt.t < pm.t) {
    if(q != null) q.fromInt(0);
    if(r != null) this.copyTo(r);
    return;
  }
  if(r == null) r = nbi();
  var y = nbi(), ts = this.s, ms = m.s;
  var nsh = this.DB-nbits(pm.data[pm.t-1]);	// normalize modulus
  if(nsh > 0) { pm.lShiftTo(nsh,y); pt.lShiftTo(nsh,r); }
  else { pm.copyTo(y); pt.copyTo(r); }
  var ys = y.t;
  var y0 = y.data[ys-1];
  if(y0 == 0) return;
  var yt = y0*(1<<this.F1)+((ys>1)?y.data[ys-2]>>this.F2:0);
  var d1 = this.FV/yt, d2 = (1<<this.F1)/yt, e = 1<<this.F2;
  var i = r.t, j = i-ys, t = (q==null)?nbi():q;
  y.dlShiftTo(j,t);
  if(r.compareTo(t) >= 0) {
    r.data[r.t++] = 1;
    r.subTo(t,r);
  }
  BigInteger.ONE.dlShiftTo(ys,t);
  t.subTo(y,y);	// "negative" y so we can replace sub with am later
  while(y.t < ys) y.data[y.t++] = 0;
  while(--j >= 0) {
    // Estimate quotient digit
    var qd = (r.data[--i]==y0)?this.DM:Math.floor(r.data[i]*d1+(r.data[i-1]+e)*d2);
    if((r.data[i]+=y.am(0,qd,r,j,0,ys)) < qd) {	// Try it out
      y.dlShiftTo(j,t);
      r.subTo(t,r);
      while(r.data[i] < --qd) r.subTo(t,r);
    }
  }
  if(q != null) {
    r.drShiftTo(ys,q);
    if(ts != ms) BigInteger.ZERO.subTo(q,q);
  }
  r.t = ys;
  r.clamp();
  if(nsh > 0) r.rShiftTo(nsh,r);	// Denormalize remainder
  if(ts < 0) BigInteger.ZERO.subTo(r,r);
}

// (public) this mod a
function bnMod(a) {
  var r = nbi();
  this.abs().divRemTo(a,null,r);
  if(this.s < 0 && r.compareTo(BigInteger.ZERO) > 0) a.subTo(r,r);
  return r;
}

// Modular reduction using "classic" algorithm
function Classic(m) { this.m = m; }
function cConvert(x) {
  if(x.s < 0 || x.compareTo(this.m) >= 0) return x.mod(this.m);
  else return x;
}
function cRevert(x) { return x; }
function cReduce(x) { x.divRemTo(this.m,null,x); }
function cMulTo(x,y,r) { x.multiplyTo(y,r); this.reduce(r); }
function cSqrTo(x,r) { x.squareTo(r); this.reduce(r); }

Classic.prototype.convert = cConvert;
Classic.prototype.revert = cRevert;
Classic.prototype.reduce = cReduce;
Classic.prototype.mulTo = cMulTo;
Classic.prototype.sqrTo = cSqrTo;

// (protected) return "-1/this % 2^DB"; useful for Mont. reduction
// justification:
//         xy == 1 (mod m)
//         xy =  1+km
//   xy(2-xy) = (1+km)(1-km)
// x[y(2-xy)] = 1-k^2m^2
// x[y(2-xy)] == 1 (mod m^2)
// if y is 1/x mod m, then y(2-xy) is 1/x mod m^2
// should reduce x and y(2-xy) by m^2 at each step to keep size bounded.
// JS multiply "overflows" differently from C/C++, so care is needed here.
function bnpInvDigit() {
  if(this.t < 1) return 0;
  var x = this.data[0];
  if((x&1) == 0) return 0;
  var y = x&3;		// y == 1/x mod 2^2
  y = (y*(2-(x&0xf)*y))&0xf;	// y == 1/x mod 2^4
  y = (y*(2-(x&0xff)*y))&0xff;	// y == 1/x mod 2^8
  y = (y*(2-(((x&0xffff)*y)&0xffff)))&0xffff;	// y == 1/x mod 2^16
  // last step - calculate inverse mod DV directly;
  // assumes 16 < DB <= 32 and assumes ability to handle 48-bit ints
  y = (y*(2-x*y%this.DV))%this.DV;		// y == 1/x mod 2^dbits
  // we really want the negative inverse, and -DV < y < DV
  return (y>0)?this.DV-y:-y;
}

// Montgomery reduction
function Montgomery(m) {
  this.m = m;
  this.mp = m.invDigit();
  this.mpl = this.mp&0x7fff;
  this.mph = this.mp>>15;
  this.um = (1<<(m.DB-15))-1;
  this.mt2 = 2*m.t;
}

// xR mod m
function montConvert(x) {
  var r = nbi();
  x.abs().dlShiftTo(this.m.t,r);
  r.divRemTo(this.m,null,r);
  if(x.s < 0 && r.compareTo(BigInteger.ZERO) > 0) this.m.subTo(r,r);
  return r;
}

// x/R mod m
function montRevert(x) {
  var r = nbi();
  x.copyTo(r);
  this.reduce(r);
  return r;
}

// x = x/R mod m (HAC 14.32)
function montReduce(x) {
  while(x.t <= this.mt2)	// pad x so am has enough room later
    x.data[x.t++] = 0;
  for(var i = 0; i < this.m.t; ++i) {
    // faster way of calculating u0 = x.data[i]*mp mod DV
    var j = x.data[i]&0x7fff;
    var u0 = (j*this.mpl+(((j*this.mph+(x.data[i]>>15)*this.mpl)&this.um)<<15))&x.DM;
    // use am to combine the multiply-shift-add into one call
    j = i+this.m.t;
    x.data[j] += this.m.am(0,u0,x,i,0,this.m.t);
    // propagate carry
    while(x.data[j] >= x.DV) { x.data[j] -= x.DV; x.data[++j]++; }
  }
  x.clamp();
  x.drShiftTo(this.m.t,x);
  if(x.compareTo(this.m) >= 0) x.subTo(this.m,x);
}

// r = "x^2/R mod m"; x != r
function montSqrTo(x,r) { x.squareTo(r); this.reduce(r); }

// r = "xy/R mod m"; x,y != r
function montMulTo(x,y,r) { x.multiplyTo(y,r); this.reduce(r); }

Montgomery.prototype.convert = montConvert;
Montgomery.prototype.revert = montRevert;
Montgomery.prototype.reduce = montReduce;
Montgomery.prototype.mulTo = montMulTo;
Montgomery.prototype.sqrTo = montSqrTo;

// (protected) true iff this is even
function bnpIsEven() { return ((this.t>0)?(this.data[0]&1):this.s) == 0; }

// (protected) this^e, e < 2^32, doing sqr and mul with "r" (HAC 14.79)
function bnpExp(e,z) {
  if(e > 0xffffffff || e < 1) return BigInteger.ONE;
  var r = nbi(), r2 = nbi(), g = z.convert(this), i = nbits(e)-1;
  g.copyTo(r);
  while(--i >= 0) {
    z.sqrTo(r,r2);
    if((e&(1<<i)) > 0) z.mulTo(r2,g,r);
    else { var t = r; r = r2; r2 = t; }
  }
  return z.revert(r);
}

// (public) this^e % m, 0 <= e < 2^32
function bnModPowInt(e,m) {
  var z;
  if(e < 256 || m.isEven()) z = new Classic(m); else z = new Montgomery(m);
  return this.exp(e,z);
}

// protected
BigInteger.prototype.copyTo = bnpCopyTo;
BigInteger.prototype.fromInt = bnpFromInt;
BigInteger.prototype.fromString = bnpFromString;
BigInteger.prototype.clamp = bnpClamp;
BigInteger.prototype.dlShiftTo = bnpDLShiftTo;
BigInteger.prototype.drShiftTo = bnpDRShiftTo;
BigInteger.prototype.lShiftTo = bnpLShiftTo;
BigInteger.prototype.rShiftTo = bnpRShiftTo;
BigInteger.prototype.subTo = bnpSubTo;
BigInteger.prototype.multiplyTo = bnpMultiplyTo;
BigInteger.prototype.squareTo = bnpSquareTo;
BigInteger.prototype.divRemTo = bnpDivRemTo;
BigInteger.prototype.invDigit = bnpInvDigit;
BigInteger.prototype.isEven = bnpIsEven;
BigInteger.prototype.exp = bnpExp;

// public
BigInteger.prototype.toString = bnToString;
BigInteger.prototype.negate = bnNegate;
BigInteger.prototype.abs = bnAbs;
BigInteger.prototype.compareTo = bnCompareTo;
BigInteger.prototype.bitLength = bnBitLength;
BigInteger.prototype.mod = bnMod;
BigInteger.prototype.modPowInt = bnModPowInt;

// "constants"
BigInteger.ZERO = nbv(0);
BigInteger.ONE = nbv(1);


// Copyright (c) 2005-2009  Tom Wu
// All Rights Reserved.
// See "LICENSE" for details.

// Extended JavaScript BN functions, required for RSA private ops.

// Version 1.1: new BigInteger("0", 10) returns "proper" zero
// Version 1.2: square() API, isProbablePrime fix

// (public)
function bnClone() { var r = nbi(); this.copyTo(r); return r; }

// (public) return value as integer
function bnIntValue() {
  if(this.s < 0) {
    if(this.t == 1) return this.data[0]-this.DV;
    else if(this.t == 0) return -1;
  }
  else if(this.t == 1) return this.data[0];
  else if(this.t == 0) return 0;
  // assumes 16 < DB < 32
  return ((this.data[1]&((1<<(32-this.DB))-1))<<this.DB)|this.data[0];
}

// (public) return value as byte
function bnByteValue() { return (this.t==0)?this.s:(this.data[0]<<24)>>24; }

// (public) return value as short (assumes DB>=16)
function bnShortValue() { return (this.t==0)?this.s:(this.data[0]<<16)>>16; }

// (protected) return x s.t. r^x < DV
function bnpChunkSize(r) { return Math.floor(Math.LN2*this.DB/Math.log(r)); }

// (public) 0 if this == 0, 1 if this > 0
function bnSigNum() {
  if(this.s < 0) return -1;
  else if(this.t <= 0 || (this.t == 1 && this.data[0] <= 0)) return 0;
  else return 1;
}

// (protected) convert to radix string
function bnpToRadix(b) {
  if(b == null) b = 10;
  if(this.signum() == 0 || b < 2 || b > 36) return "0";
  var cs = this.chunkSize(b);
  var a = Math.pow(b,cs);
  var d = nbv(a), y = nbi(), z = nbi(), r = "";
  this.divRemTo(d,y,z);
  while(y.signum() > 0) {
    r = (a+z.intValue()).toString(b).substr(1) + r;
    y.divRemTo(d,y,z);
  }
  return z.intValue().toString(b) + r;
}

// (protected) convert from radix string
function bnpFromRadix(s,b) {
  this.fromInt(0);
  if(b == null) b = 10;
  var cs = this.chunkSize(b);
  var d = Math.pow(b,cs), mi = false, j = 0, w = 0;
  for(var i = 0; i < s.length; ++i) {
    var x = intAt(s,i);
    if(x < 0) {
      if(s.charAt(i) == "-" && this.signum() == 0) mi = true;
      continue;
    }
    w = b*w+x;
    if(++j >= cs) {
      this.dMultiply(d);
      this.dAddOffset(w,0);
      j = 0;
      w = 0;
    }
  }
  if(j > 0) {
    this.dMultiply(Math.pow(b,j));
    this.dAddOffset(w,0);
  }
  if(mi) BigInteger.ZERO.subTo(this,this);
}

// (protected) alternate constructor
function bnpFromNumber(a,b,c) {
  if("number" == typeof b) {
    // new BigInteger(int,int,RNG)
    if(a < 2) this.fromInt(1);
    else {
      this.fromNumber(a,c);
      if(!this.testBit(a-1))   // force MSB set
        this.bitwiseTo(BigInteger.ONE.shiftLeft(a-1),op_or,this);
      if(this.isEven()) this.dAddOffset(1,0); // force odd
      while(!this.isProbablePrime(b)) {
        this.dAddOffset(2,0);
        if(this.bitLength() > a) this.subTo(BigInteger.ONE.shiftLeft(a-1),this);
      }
    }
  }
  else {
    // new BigInteger(int,RNG)
    var x = new Array(), t = a&7;
    x.length = (a>>3)+1;
    b.nextBytes(x);
    if(t > 0) x[0] &= ((1<<t)-1); else x[0] = 0;
    this.fromString(x,256);
  }
}

// (public) convert to bigendian byte array
function bnToByteArray() {
  var i = this.t, r = new Array();
  r[0] = this.s;
  var p = this.DB-(i*this.DB)%8, d, k = 0;
  if(i-- > 0) {
    if(p < this.DB && (d = this.data[i]>>p) != (this.s&this.DM)>>p)
      r[k++] = d|(this.s<<(this.DB-p));
    while(i >= 0) {
      if(p < 8) {
        d = (this.data[i]&((1<<p)-1))<<(8-p);
        d |= this.data[--i]>>(p+=this.DB-8);
      }
      else {
        d = (this.data[i]>>(p-=8))&0xff;
        if(p <= 0) { p += this.DB; --i; }
      }
      if((d&0x80) != 0) d |= -256;
      if(k == 0 && (this.s&0x80) != (d&0x80)) ++k;
      if(k > 0 || d != this.s) r[k++] = d;
    }
  }
  return r;
}

function bnEquals(a) { return(this.compareTo(a)==0); }
function bnMin(a) { return(this.compareTo(a)<0)?this:a; }
function bnMax(a) { return(this.compareTo(a)>0)?this:a; }

// (protected) r = this op a (bitwise)
function bnpBitwiseTo(a,op,r) {
  var i, f, m = Math.min(a.t,this.t);
  for(i = 0; i < m; ++i) r.data[i] = op(this.data[i],a.data[i]);
  if(a.t < this.t) {
    f = a.s&this.DM;
    for(i = m; i < this.t; ++i) r.data[i] = op(this.data[i],f);
    r.t = this.t;
  }
  else {
    f = this.s&this.DM;
    for(i = m; i < a.t; ++i) r.data[i] = op(f,a.data[i]);
    r.t = a.t;
  }
  r.s = op(this.s,a.s);
  r.clamp();
}

// (public) this & a
function op_and(x,y) { return x&y; }
function bnAnd(a) { var r = nbi(); this.bitwiseTo(a,op_and,r); return r; }

// (public) this | a
function op_or(x,y) { return x|y; }
function bnOr(a) { var r = nbi(); this.bitwiseTo(a,op_or,r); return r; }

// (public) this ^ a
function op_xor(x,y) { return x^y; }
function bnXor(a) { var r = nbi(); this.bitwiseTo(a,op_xor,r); return r; }

// (public) this & ~a
function op_andnot(x,y) { return x&~y; }
function bnAndNot(a) { var r = nbi(); this.bitwiseTo(a,op_andnot,r); return r; }

// (public) ~this
function bnNot() {
  var r = nbi();
  for(var i = 0; i < this.t; ++i) r.data[i] = this.DM&~this.data[i];
  r.t = this.t;
  r.s = ~this.s;
  return r;
}

// (public) this << n
function bnShiftLeft(n) {
  var r = nbi();
  if(n < 0) this.rShiftTo(-n,r); else this.lShiftTo(n,r);
  return r;
}

// (public) this >> n
function bnShiftRight(n) {
  var r = nbi();
  if(n < 0) this.lShiftTo(-n,r); else this.rShiftTo(n,r);
  return r;
}

// return index of lowest 1-bit in x, x < 2^31
function lbit(x) {
  if(x == 0) return -1;
  var r = 0;
  if((x&0xffff) == 0) { x >>= 16; r += 16; }
  if((x&0xff) == 0) { x >>= 8; r += 8; }
  if((x&0xf) == 0) { x >>= 4; r += 4; }
  if((x&3) == 0) { x >>= 2; r += 2; }
  if((x&1) == 0) ++r;
  return r;
}

// (public) returns index of lowest 1-bit (or -1 if none)
function bnGetLowestSetBit() {
  for(var i = 0; i < this.t; ++i)
    if(this.data[i] != 0) return i*this.DB+lbit(this.data[i]);
  if(this.s < 0) return this.t*this.DB;
  return -1;
}

// return number of 1 bits in x
function cbit(x) {
  var r = 0;
  while(x != 0) { x &= x-1; ++r; }
  return r;
}

// (public) return number of set bits
function bnBitCount() {
  var r = 0, x = this.s&this.DM;
  for(var i = 0; i < this.t; ++i) r += cbit(this.data[i]^x);
  return r;
}

// (public) true iff nth bit is set
function bnTestBit(n) {
  var j = Math.floor(n/this.DB);
  if(j >= this.t) return(this.s!=0);
  return((this.data[j]&(1<<(n%this.DB)))!=0);
}

// (protected) this op (1<<n)
function bnpChangeBit(n,op) {
  var r = BigInteger.ONE.shiftLeft(n);
  this.bitwiseTo(r,op,r);
  return r;
}

// (public) this | (1<<n)
function bnSetBit(n) { return this.changeBit(n,op_or); }

// (public) this & ~(1<<n)
function bnClearBit(n) { return this.changeBit(n,op_andnot); }

// (public) this ^ (1<<n)
function bnFlipBit(n) { return this.changeBit(n,op_xor); }

// (protected) r = this + a
function bnpAddTo(a,r) {
  var i = 0, c = 0, m = Math.min(a.t,this.t);
  while(i < m) {
    c += this.data[i]+a.data[i];
    r.data[i++] = c&this.DM;
    c >>= this.DB;
  }
  if(a.t < this.t) {
    c += a.s;
    while(i < this.t) {
      c += this.data[i];
      r.data[i++] = c&this.DM;
      c >>= this.DB;
    }
    c += this.s;
  }
  else {
    c += this.s;
    while(i < a.t) {
      c += a.data[i];
      r.data[i++] = c&this.DM;
      c >>= this.DB;
    }
    c += a.s;
  }
  r.s = (c<0)?-1:0;
  if(c > 0) r.data[i++] = c;
  else if(c < -1) r.data[i++] = this.DV+c;
  r.t = i;
  r.clamp();
}

// (public) this + a
function bnAdd(a) { var r = nbi(); this.addTo(a,r); return r; }

// (public) this - a
function bnSubtract(a) { var r = nbi(); this.subTo(a,r); return r; }

// (public) this * a
function bnMultiply(a) { var r = nbi(); this.multiplyTo(a,r); return r; }

// (public) this^2
function bnSquare() { var r = nbi(); this.squareTo(r); return r; }

// (public) this / a
function bnDivide(a) { var r = nbi(); this.divRemTo(a,r,null); return r; }

// (public) this % a
function bnRemainder(a) { var r = nbi(); this.divRemTo(a,null,r); return r; }

// (public) [this/a,this%a]
function bnDivideAndRemainder(a) {
  var q = nbi(), r = nbi();
  this.divRemTo(a,q,r);
  return new Array(q,r);
}

// (protected) this *= n, this >= 0, 1 < n < DV
function bnpDMultiply(n) {
  this.data[this.t] = this.am(0,n-1,this,0,0,this.t);
  ++this.t;
  this.clamp();
}

// (protected) this += n << w words, this >= 0
function bnpDAddOffset(n,w) {
  if(n == 0) return;
  while(this.t <= w) this.data[this.t++] = 0;
  this.data[w] += n;
  while(this.data[w] >= this.DV) {
    this.data[w] -= this.DV;
    if(++w >= this.t) this.data[this.t++] = 0;
    ++this.data[w];
  }
}

// A "null" reducer
function NullExp() {}
function nNop(x) { return x; }
function nMulTo(x,y,r) { x.multiplyTo(y,r); }
function nSqrTo(x,r) { x.squareTo(r); }

NullExp.prototype.convert = nNop;
NullExp.prototype.revert = nNop;
NullExp.prototype.mulTo = nMulTo;
NullExp.prototype.sqrTo = nSqrTo;

// (public) this^e
function bnPow(e) { return this.exp(e,new NullExp()); }

// (protected) r = lower n words of "this * a", a.t <= n
// "this" should be the larger one if appropriate.
function bnpMultiplyLowerTo(a,n,r) {
  var i = Math.min(this.t+a.t,n);
  r.s = 0; // assumes a,this >= 0
  r.t = i;
  while(i > 0) r.data[--i] = 0;
  var j;
  for(j = r.t-this.t; i < j; ++i) r.data[i+this.t] = this.am(0,a.data[i],r,i,0,this.t);
  for(j = Math.min(a.t,n); i < j; ++i) this.am(0,a.data[i],r,i,0,n-i);
  r.clamp();
}

// (protected) r = "this * a" without lower n words, n > 0
// "this" should be the larger one if appropriate.
function bnpMultiplyUpperTo(a,n,r) {
  --n;
  var i = r.t = this.t+a.t-n;
  r.s = 0; // assumes a,this >= 0
  while(--i >= 0) r.data[i] = 0;
  for(i = Math.max(n-this.t,0); i < a.t; ++i)
    r.data[this.t+i-n] = this.am(n-i,a.data[i],r,0,0,this.t+i-n);
  r.clamp();
  r.drShiftTo(1,r);
}

// Barrett modular reduction
function Barrett(m) {
  // setup Barrett
  this.r2 = nbi();
  this.q3 = nbi();
  BigInteger.ONE.dlShiftTo(2*m.t,this.r2);
  this.mu = this.r2.divide(m);
  this.m = m;
}

function barrettConvert(x) {
  if(x.s < 0 || x.t > 2*this.m.t) return x.mod(this.m);
  else if(x.compareTo(this.m) < 0) return x;
  else { var r = nbi(); x.copyTo(r); this.reduce(r); return r; }
}

function barrettRevert(x) { return x; }

// x = x mod m (HAC 14.42)
function barrettReduce(x) {
  x.drShiftTo(this.m.t-1,this.r2);
  if(x.t > this.m.t+1) { x.t = this.m.t+1; x.clamp(); }
  this.mu.multiplyUpperTo(this.r2,this.m.t+1,this.q3);
  this.m.multiplyLowerTo(this.q3,this.m.t+1,this.r2);
  while(x.compareTo(this.r2) < 0) x.dAddOffset(1,this.m.t+1);
  x.subTo(this.r2,x);
  while(x.compareTo(this.m) >= 0) x.subTo(this.m,x);
}

// r = x^2 mod m; x != r
function barrettSqrTo(x,r) { x.squareTo(r); this.reduce(r); }

// r = x*y mod m; x,y != r
function barrettMulTo(x,y,r) { x.multiplyTo(y,r); this.reduce(r); }

Barrett.prototype.convert = barrettConvert;
Barrett.prototype.revert = barrettRevert;
Barrett.prototype.reduce = barrettReduce;
Barrett.prototype.mulTo = barrettMulTo;
Barrett.prototype.sqrTo = barrettSqrTo;

// (public) this^e % m (HAC 14.85)
function bnModPow(e,m) {
  var i = e.bitLength(), k, r = nbv(1), z;
  if(i <= 0) return r;
  else if(i < 18) k = 1;
  else if(i < 48) k = 3;
  else if(i < 144) k = 4;
  else if(i < 768) k = 5;
  else k = 6;
  if(i < 8)
    z = new Classic(m);
  else if(m.isEven())
    z = new Barrett(m);
  else
    z = new Montgomery(m);

  // precomputation
  var g = new Array(), n = 3, k1 = k-1, km = (1<<k)-1;
  g[1] = z.convert(this);
  if(k > 1) {
    var g2 = nbi();
    z.sqrTo(g[1],g2);
    while(n <= km) {
      g[n] = nbi();
      z.mulTo(g2,g[n-2],g[n]);
      n += 2;
    }
  }

  var j = e.t-1, w, is1 = true, r2 = nbi(), t;
  i = nbits(e.data[j])-1;
  while(j >= 0) {
    if(i >= k1) w = (e.data[j]>>(i-k1))&km;
    else {
      w = (e.data[j]&((1<<(i+1))-1))<<(k1-i);
      if(j > 0) w |= e.data[j-1]>>(this.DB+i-k1);
    }

    n = k;
    while((w&1) == 0) { w >>= 1; --n; }
    if((i -= n) < 0) { i += this.DB; --j; }
    if(is1) {  // ret == 1, don't bother squaring or multiplying it
      g[w].copyTo(r);
      is1 = false;
    }
    else {
      while(n > 1) { z.sqrTo(r,r2); z.sqrTo(r2,r); n -= 2; }
      if(n > 0) z.sqrTo(r,r2); else { t = r; r = r2; r2 = t; }
      z.mulTo(r2,g[w],r);
    }

    while(j >= 0 && (e.data[j]&(1<<i)) == 0) {
      z.sqrTo(r,r2); t = r; r = r2; r2 = t;
      if(--i < 0) { i = this.DB-1; --j; }
    }
  }
  return z.revert(r);
}

// (public) gcd(this,a) (HAC 14.54)
function bnGCD(a) {
  var x = (this.s<0)?this.negate():this.clone();
  var y = (a.s<0)?a.negate():a.clone();
  if(x.compareTo(y) < 0) { var t = x; x = y; y = t; }
  var i = x.getLowestSetBit(), g = y.getLowestSetBit();
  if(g < 0) return x;
  if(i < g) g = i;
  if(g > 0) {
    x.rShiftTo(g,x);
    y.rShiftTo(g,y);
  }
  while(x.signum() > 0) {
    if((i = x.getLowestSetBit()) > 0) x.rShiftTo(i,x);
    if((i = y.getLowestSetBit()) > 0) y.rShiftTo(i,y);
    if(x.compareTo(y) >= 0) {
      x.subTo(y,x);
      x.rShiftTo(1,x);
    }
    else {
      y.subTo(x,y);
      y.rShiftTo(1,y);
    }
  }
  if(g > 0) y.lShiftTo(g,y);
  return y;
}

// (protected) this % n, n < 2^26
function bnpModInt(n) {
  if(n <= 0) return 0;
  var d = this.DV%n, r = (this.s<0)?n-1:0;
  if(this.t > 0)
    if(d == 0) r = this.data[0]%n;
    else for(var i = this.t-1; i >= 0; --i) r = (d*r+this.data[i])%n;
  return r;
}

// (public) 1/this % m (HAC 14.61)
function bnModInverse(m) {
  var ac = m.isEven();
  if((this.isEven() && ac) || m.signum() == 0) return BigInteger.ZERO;
  var u = m.clone(), v = this.clone();
  var a = nbv(1), b = nbv(0), c = nbv(0), d = nbv(1);
  while(u.signum() != 0) {
    while(u.isEven()) {
      u.rShiftTo(1,u);
      if(ac) {
        if(!a.isEven() || !b.isEven()) { a.addTo(this,a); b.subTo(m,b); }
        a.rShiftTo(1,a);
      }
      else if(!b.isEven()) b.subTo(m,b);
      b.rShiftTo(1,b);
    }
    while(v.isEven()) {
      v.rShiftTo(1,v);
      if(ac) {
        if(!c.isEven() || !d.isEven()) { c.addTo(this,c); d.subTo(m,d); }
        c.rShiftTo(1,c);
      }
      else if(!d.isEven()) d.subTo(m,d);
      d.rShiftTo(1,d);
    }
    if(u.compareTo(v) >= 0) {
      u.subTo(v,u);
      if(ac) a.subTo(c,a);
      b.subTo(d,b);
    }
    else {
      v.subTo(u,v);
      if(ac) c.subTo(a,c);
      d.subTo(b,d);
    }
  }
  if(v.compareTo(BigInteger.ONE) != 0) return BigInteger.ZERO;
  if(d.compareTo(m) >= 0) return d.subtract(m);
  if(d.signum() < 0) d.addTo(m,d); else return d;
  if(d.signum() < 0) return d.add(m); else return d;
}

var lowprimes = [2,3,5,7,11,13,17,19,23,29,31,37,41,43,47,53,59,61,67,71,73,79,83,89,97,101,103,107,109,113,127,131,137,139,149,151,157,163,167,173,179,181,191,193,197,199,211,223,227,229,233,239,241,251,257,263,269,271,277,281,283,293,307,311,313,317,331,337,347,349,353,359,367,373,379,383,389,397,401,409,419,421,431,433,439,443,449,457,461,463,467,479,487,491,499,503,509,521,523,541,547,557,563,569,571,577,587,593,599,601,607,613,617,619,631,641,643,647,653,659,661,673,677,683,691,701,709,719,727,733,739,743,751,757,761,769,773,787,797,809,811,821,823,827,829,839,853,857,859,863,877,881,883,887,907,911,919,929,937,941,947,953,967,971,977,983,991,997];
var lplim = (1<<26)/lowprimes[lowprimes.length-1];

// (public) test primality with certainty >= 1-.5^t
function bnIsProbablePrime(t) {
  var i, x = this.abs();
  if(x.t == 1 && x.data[0] <= lowprimes[lowprimes.length-1]) {
    for(i = 0; i < lowprimes.length; ++i)
      if(x.data[0] == lowprimes[i]) return true;
    return false;
  }
  if(x.isEven()) return false;
  i = 1;
  while(i < lowprimes.length) {
    var m = lowprimes[i], j = i+1;
    while(j < lowprimes.length && m < lplim) m *= lowprimes[j++];
    m = x.modInt(m);
    while(i < j) if(m%lowprimes[i++] == 0) return false;
  }
  return x.millerRabin(t);
}

// (protected) true if probably prime (HAC 4.24, Miller-Rabin)
function bnpMillerRabin(t) {
  var n1 = this.subtract(BigInteger.ONE);
  var k = n1.getLowestSetBit();
  if(k <= 0) return false;
  var r = n1.shiftRight(k);
  t = (t+1)>>1;
  if(t > lowprimes.length) t = lowprimes.length;
  var a = nbi();
  for(var i = 0; i < t; ++i) {
    // Pick bases at random, instead of starting at 2
    a.fromInt(lowprimes[Math.floor(Math.random()*lowprimes.length)]);
    var y = a.modPow(r,this);
    if(y.compareTo(BigInteger.ONE) != 0 && y.compareTo(n1) != 0) {
      var j = 1;
      while(j++ < k && y.compareTo(n1) != 0) {
        y = y.modPowInt(2,this);
        if(y.compareTo(BigInteger.ONE) == 0) return false;
      }
      if(y.compareTo(n1) != 0) return false;
    }
  }
  return true;
}

// protected
BigInteger.prototype.chunkSize = bnpChunkSize;
BigInteger.prototype.toRadix = bnpToRadix;
BigInteger.prototype.fromRadix = bnpFromRadix;
BigInteger.prototype.fromNumber = bnpFromNumber;
BigInteger.prototype.bitwiseTo = bnpBitwiseTo;
BigInteger.prototype.changeBit = bnpChangeBit;
BigInteger.prototype.addTo = bnpAddTo;
BigInteger.prototype.dMultiply = bnpDMultiply;
BigInteger.prototype.dAddOffset = bnpDAddOffset;
BigInteger.prototype.multiplyLowerTo = bnpMultiplyLowerTo;
BigInteger.prototype.multiplyUpperTo = bnpMultiplyUpperTo;
BigInteger.prototype.modInt = bnpModInt;
BigInteger.prototype.millerRabin = bnpMillerRabin;

// public
BigInteger.prototype.clone = bnClone;
BigInteger.prototype.intValue = bnIntValue;
BigInteger.prototype.byteValue = bnByteValue;
BigInteger.prototype.shortValue = bnShortValue;
BigInteger.prototype.signum = bnSigNum;
BigInteger.prototype.toByteArray = bnToByteArray;
BigInteger.prototype.equals = bnEquals;
BigInteger.prototype.min = bnMin;
BigInteger.prototype.max = bnMax;
BigInteger.prototype.and = bnAnd;
BigInteger.prototype.or = bnOr;
BigInteger.prototype.xor = bnXor;
BigInteger.prototype.andNot = bnAndNot;
BigInteger.prototype.not = bnNot;
BigInteger.prototype.shiftLeft = bnShiftLeft;
BigInteger.prototype.shiftRight = bnShiftRight;
BigInteger.prototype.getLowestSetBit = bnGetLowestSetBit;
BigInteger.prototype.bitCount = bnBitCount;
BigInteger.prototype.testBit = bnTestBit;
BigInteger.prototype.setBit = bnSetBit;
BigInteger.prototype.clearBit = bnClearBit;
BigInteger.prototype.flipBit = bnFlipBit;
BigInteger.prototype.add = bnAdd;
BigInteger.prototype.subtract = bnSubtract;
BigInteger.prototype.multiply = bnMultiply;
BigInteger.prototype.divide = bnDivide;
BigInteger.prototype.remainder = bnRemainder;
BigInteger.prototype.divideAndRemainder = bnDivideAndRemainder;
BigInteger.prototype.modPow = bnModPow;
BigInteger.prototype.modInverse = bnModInverse;
BigInteger.prototype.pow = bnPow;
BigInteger.prototype.gcd = bnGCD;
BigInteger.prototype.isProbablePrime = bnIsProbablePrime;

// JSBN-specific extension
BigInteger.prototype.square = bnSquare;

// BigInteger interfaces not implemented in jsbn:

// BigInteger(int signum, byte[] magnitude)
// double doubleValue()
// float floatValue()
// int hashCode()
// long longValue()
// static BigInteger valueOf(long val)

// memory management and pointer emulation

// static initialize
function h$sti(f) {
  h$initStatic.push(function() {
    var xs = f();
    var to = xs.shift();
    h$init_closure(to, xs);
  });
}

// initialize packed info tables
// see Compactor for how the data is encoded
function h$initInfoTables(n, funcs, info) {
  var pos = 0;
  function code(c) {
    if(c < 34) return c - 32;
    if(c < 92) return c - 33;
    return c -34;
  }
  function next() {
    var c = info.charCodeAt(pos);
    if(c < 124) {
      pos++;
      return code(c);
    }
    if(c === 124) {
      pos+=3;
      return 90 + 90 * code(info.charCodeAt(pos-2))
                + code(info.charCodeAt(pos-1));
    }
    if(c === 125) {
      pos+=4;
      return 8190 + 8100 * code(info.charCodeAt(pos-3)) 
                  + 90 * code(info.charCodeAt(pos-2))
                  + code(info.charCodeAt(pos-1));
    }
    throw "h$initInfoTables: invalid code in info table"
  }
  for(var i=0;i<n;i++) {
    var o = funcs[i];
    var ot, oa;
    switch(next()) {
      case 0: // thunk
        ot = 0;
        oa = 0;
        break;
      case 1: // fun
        var arity = next();
        var regs  = next();
        ot = 1
        oa = arity + (regs << 8);
        break;
      case 2:  // con
        var tag = next();
        ot = 2;
        oa = tag;
        break;
      default: throw ("h$initInfoTables: invalid closure type: " + 3)
    }
    var size = next();
    size = size === 0 ? -1 : size - 1;
    var nsrts = next();
    var srt = null;
    if(nsrts > 0) {
      srt = [];
      for(var j=0;j<nsrts;j++) {
        srt.push(funcs[next()]);
      }
    }
    // log("result: " + ot + " " + oa + " [" + srt + "] " + size);
    // log("orig: " + o.t + " " + o.a + " [" + o.s + "] " + o.gtag);
    o.t    = ot;
    o.i    = [];
    o.n    = "";
    o.a    = oa;
    o.gai  = [];
    o.s    = srt;
    o.m    = null;
    o.gtag = size;
    o.gi   = [];
  }
}

// slice an array of heap objects
var h$sliceArray = /* ArrayBuffer.prototype.slice ?
  function(a, start, n) {
    return new Int32Array(a.buffer.slice(start, n));
  }
  : */
  function(a, start, n) {
    var tgt = [];
    for(var i=0;i<n;i++) {
      tgt[i] = a[start+i];
    }
    return tgt;
  }


function h$memcpy() {
  if(arguments.length === 3) {  // ByteArray# -> ByteArray# copy
    var dst = arguments[0];
    var src = arguments[1];
    var n   = arguments[2];
    for(var i=n-1;i>=0;i--) {
      dst.u8[i] = src.u8[i];
    }
    ret1 = 0;
    return dst;
  } else if(arguments.length === 5) { // Addr# -> Addr# copy
    var dst = arguments[0];
    var dst_off = arguments[1]
    var src = arguments[2];
    var src_off = arguments[3];
    var n   = arguments[4];
    for(var i=n-1;i>=0;i--) {
      dst.u8[i+dst_off] = src.u8[i+src_off];
    }
    ret1 = dst_off;
    return dst;
  } else {
    throw "h$memcpy: unexpected argument";
  }
}

function h$memchr(a_v, a_o, c, n) {
  for(var i=0;i<n;i++) {
    if(a_v.u8[a_o+i] === c) {
      h$ret1 = a_o+i;
      return a_v;
    }
  }
  h$ret1 = 0;
  return null;
}

function h$strlen(a_v, a_o) {
  var i=0;
  while(true) {
    if(a_v.u8[a_o+i] === 0) { return i; }
    i++;
  }
}

function h$fps_reverse(a_v, a_o, b_v, b_o, n) {
  for(var i=0;i<n;i++) {
    a_v.u8[a_o+n-i-1] = b_v.u8[b_o+i];
  }
}

function h$fps_intersperse(a_v,a_o,b_v,b_o,n,c) {
  var dst_o = a_o;
  for(var i=0;i<n-1;i++) {
    a_v.u8[dst_o] = b_v.u8[b_o+i];
    a_v.u8[dst_o+1] = c;
    dst_o += 2;
  }
  if(n > 0) {
    a_v.u8[dst_o] = v_c.u8[b_o+n-1];
  }
}

function h$fps_maximum(a_v,a_o,n) {
  var max = a_v.u8[a_o];
  for(var i=1;i<n;i++) {
    var c = a_v.u8[a_o+i];
    if(c > max) { max = c; }
  }
  return max;
}

function h$fps_minimum(a_v,a_o,n) {
  var min = a_v.u8[a_o];
  for(var i=1;i<n;i++) {
    var c = a_v.u8[a_o+i];
    if(c < min) { min = c; }
  }
  return min;
}

function h$fps_count(a_v,a_o,n,c) {
  var count = 0;
  for(var i=0;i<n;i++) {
    if(a_v.u8[a_o+i] === c) { count++; }
  }
  return count|0;
}

function h$newArray(len,e) {
  var r = [];
  for(var i=0;i<len;i++) { r[i] = e; }
  return r;
}

function h$roundUpToMultipleOf(n,m) {
  var rem = n % m;
  return rem === 0 ? n : n - rem + m;
}

function h$newByteArray(len) {
  var len0 = Math.max(h$roundUpToMultipleOf(len, 8), 8);
  var buf = new ArrayBuffer(len0);
  return { buf: buf
         , len: len
         , i3: new Int32Array(buf)
         , u8: new Uint8Array(buf)
         , u1: new Uint16Array(buf)
         , f3: new Float32Array(buf)
         , f6: new Float64Array(buf)
         , dv: new DataView(buf)
         }
}

// wrap an ArrayBuffer so that it can be used as a ByteArray#
// with the most common view prespun
// offset and length are optional, both are in bytes
// if unaligned ok, then unaligned fields will be null
function h$wrapBuffer(buf, unalignedOk, offset, length) {
  if(!unalignedOk && offset && offset % 8 != 0) {
    throw ("h$wrapBuffer offset not aligned:" + offset);
  }
  if(!offset) { offset = 0; }
  if(!length) { length = buf.byteLength - offset; }
  // log("h$wrapBuffer: " + offset + " " + length);
  return { buf: buf
         , len: length
         , i3: (offset%4) ? null : new Int32Array(buf, offset, length >> 2)
         , u8: new Uint8Array(buf, offset, length)
         , u1: (offset%2) ? null : new Uint16Array(buf, offset, length >> 1)
         , f3: (offset%4) ? null : new Float32Array(buf, offset, length >> 2)
         , f6: (offset%8) ? null : new Float64Array(buf, offset, length >> 3)
         , dv: new DataView(buf, offset, length)
         };
}

// try to compute a reasonably unique int key from object data
// used to calculate the StableName int
// note: be careful to not use any mutable properties for this
// - numbers directly on the heap shouldn't change
// - o.m >> 2 shouldn't change if it's nonzero
h$stableNameN = 1;
// semi-unique in the upper 14 bits of the .m thing
function h$getObjectKey(o) {
  var x = o.m;
  if(o.m >> 18 === 0) {
    o.m |= ++h$stableNameN << 18;
  }
  return o.m >> 18;
}

function h$getObjectHash(o) {
  if(o === null) {
    return 230948;
  } if(typeof o === 'number') {
    return o|0;
  } else if(typeof o === 'object' && o.hasOwnProperty('m') && typeof o.m === 'number') {
    return h$getObjectKey(o);
  } else {
    return 3456333333;
  }
}

function h$makeStableName(x) {
  if(typeof x === 'object') {
    return [x,x.f];
  } else {
    return [x,null];
  }
}

function h$stableNameInt(s) {
  // log("h$stableNameInt: " + (typeof s[0]));
  var s0 = s[0];
  if(typeof s0 === 'boolean') { return s0?1:0; }
  if(typeof s0 === 'number') { return s0|0; } // fixme this won't work well with small floats 
  var hash = 23;
  hash = (hash * 37 + h$getObjectKey(s0))|0;
  hash = (hash * 37 + h$getObjectHash(s0.d1))|0;
  hash = (hash * 37 + h$getObjectHash(s0.d2))|0;
  return hash;
}

function h$eqStableName(s1o,s2o) {
  var s1 = s1o[0];
  var s2 = s2o[0];
  if(typeof s1 !== 'object' || typeof s2 !== 'object') {
    return s1 === s2 ? 1 : 0;
  }
  var s1f = s1o[1];
  var s2f = s2o[1];
  return (s1f === s2f && (s1 === s2 || (s1.f === s2.f && s1.d1 === s2.d1 && s1.d2 === s2.d2)))?1:0;
}

function h$makeStablePtr(v) {
  var buf = h$newByteArray(4);
  buf.arr = [v];
  h$ret1 = 0;
  return buf;
}

function h$hs_free_stable_ptr(stable) {

}

function h$malloc(n) {
  h$ret1 = 0;
  return h$newByteArray(n);
}

function h$free() {

}

function h$memset() {
  var buf_v, buf_off, chr, n;
  buf_v = arguments[0];
  if(arguments.length == 4) { // Addr#
    buf_off = arguments[1];
    chr     = arguments[2];
    n       = arguments[3];
  } else if(arguments.length == 3) { // ByteString#
    buf_off = 0;
    chr     = arguments[1];
    n       = arguments[2];
  } else {
    throw("h$memset: unexpected argument")
  }
  var end = buf_off + n;
  for(var i=buf_off;i<end;i++) {
    buf_v.u8[i] = chr;
  }
  ret1 = buf_off;
  return buf_v;
}

function h$memcmp(a_v, a_o, b_v, b_o, n) {
  for(var i=0;i<n;i++) {
    var a = a_v.u8[a_o+i];
    var b = b_v.u8[b_o+i];
    var c = a-b;
    if(c !== 0) { return c; }
  }
  return 0;
}

function h$memmove(a_v, a_o, b_v, b_o, n) {
  if(n > 0) {
    var tmp = new Uint8Array(b_v.buf.slice(b_o,b_o+n));
    for(var i=0;i<n;i++) {
      a_v.u8[a_o+i] = tmp[i];
    }
  }
  h$ret1 = a_o;
  return a_v;
}
function h$mkPtr(v, o) {
  return h$c2(h$baseZCGHCziPtrziPtr_con_e, v, o);
};
function h$mkFunctionPtr(f) {
  var d = h$newByteArray(4);
  d.arr = [f];
  return d;
}
h$freeHaskellFunctionPtr = function () {
}
function h$createAdjustor(cconv, hptr, hptr_2, wptr, wptr_2, type) {
    h$ret1 = hptr_2;
    return hptr;
};

// extra roots for the heap scanner: objects with root property
var h$extraRoots = new goog.structs.Set();

function h$makeCallback(retain, f, extraArgs, action) {
  var args = extraArgs.slice(0);
  args.unshift(action);
  var c = function() {
    return f.apply(this, args);
  }
  if(retain) {
    c.root = action;
    h$extraRoots.add(c);
  }
  return c;
}

function h$makeCallbackApply(retain, n, f, extraArgs, fun) {
  var c;
  if(n === 1) {
    c = function(x) {
      var args = extraArgs.slice(0);
      var action = h$c2(h$ap1_e, fun, h$mkJSRef(x));
      args.unshift(action);
      return f.apply(this, args);
    }
  } else if (n === 2) {
    c = function(x,y) {
      var args = extraArgs.slice(0);
      var action = h$c3(h$ap2_e, fun, h$mkJSRef(x), h$mkJSRef(y));
      args.unshift(action);
      return f.apply(this, args);
    }
  } else {
    throw "h$makeCallbackApply: unsupported arity";
  }
  if(retain) {
    c.root = fun;
    h$extraRoots.add(c);
  }
  return c;
}

function h$mkJSRef(x) {
  return h$c1(h$ghcjszmprimZCGHCJSziPrimziJSRef_con_e, x);
}

function h$freeCallback(c) {
  h$extraRoots.remove(c);
}

function h$isInstanceOf(o,c) {
  return o instanceof c;
}

/*
  do garbage collection where the JavaScript GC doesn't suffice or needs some help:
  - run finalizers for weak references
  - find unreferenced CAFs and reset them (unless h$retainCAFs is set)
  - shorten stacks that are mostly empty
  - reset unused parts of stacks to null
  - reset registers to null
  - reset return variables to null

  assumptions:
  - all threads suspended, no active registers
  - h$currentThread == null or at least unused:
       1. all reachable threads must be in h$threads or h$blocked
       2. no registers contain any usable value
  notes:
  - gc() may replace the stack of any thread, make sure to reload h$stack after gc()
*/

/*
  fixme, todo:
  - tag unreachable MVar# so that JavaScript can stop posting events
  - mark posted exceptions to thread
*/

var h$gcMark = 2; // 2 or 3 (objects initialized with 0)
var h$gcTime = 0;

var h$retainCAFs = false;
var h$CAFs = [];
var h$CAFsReset = [];

// var traceGc = log;
function traceGc() { return; }

function h$gcQuick(t) {
  var start = Date.now();
  h$resetRegisters();
  h$resetResultVars();
  var i;
  if(t !== null) { // only thread t
    h$resetThread(t);
  } else { // all threads, h$currentThread assumed unused
    var runnable = h$threads.getValues();
    for(i=0;i<runnable.length;i++) {
      h$resetThread(runnable[i]);
    }
    var iter = h$blocked.__iterator__();
    try {
      while(true) {
        t = iter.next();
        h$resetThread(t, work, weaks);
      }
    } catch(e) { if(e !== goog.iter.StopIteration) { throw e; } }
  }
  var time = Date.now() - start;
  h$gcTime += time;
  traceGc("time (quick): " + time + "ms");
  traceGc("time (total): " + h$gcTime + "ms");
}

// run full marking for threads in h$blocked and h$threads, optionally t if t /= null
var h$marked = 0;
function h$gc(t) {
//  return; // fixme debug
  h$marked = 0;
  var now = Date.now();
//  if(now - h$lastGc < 1000) {
//    return;
//  }
  h$lastGc = now;
  traceGc("gc: " + (t!==null?h$threadString(t):"null"));
  var start = Date.now();
  h$resetRegisters();
  h$resetResultVars();
  h$gcMark = 5-h$gcMark;
  var i;
  var runnable = h$threads.getValues();
  var work = [];
  var weaks = [];
  if(t !== null) {
    h$markThread(t, work, weaks);
  }
  for(i=0;i<runnable.length;i++) {
    h$markThread(runnable[i], work, weaks);
  }
  var iter = h$blocked.__iterator__();
  try {
    while(true) {
      t = iter.next();
      h$markThread(t, work, weaks);
    }
  } catch(e) { if(e !== goog.iter.StopIteration) { throw e; } }

  // we now have a bunch of weak refs, mark their finalizers and
  // values, both should not keep the key alive
  while(weaks.length > 0) {
    var w = weaks.pop();
    work.push(w.finalizer, w.val);
    h$follow(null, -1, work, weaks, w.key);
  }

  h$finalizeWeaks();
  h$finalizeCAFs();
  var time = Date.now() - start;
  h$gcTime += time;
  h$lastGc = Date.now();
  traceGc("time: " + time + "ms");
  traceGc("time (total): " + h$gcTime + "ms");
  traceGc("marked objects: " + h$marked);
}

function h$markThread(t,work,weaks) {
  var start = Date.now();
  traceGc("marking thread: " + h$threadString(t));
  var stack = t.stack;
  if(stack === null) { return; } // thread finished
  var sp = t.sp;
  var i,c;
  var mark = h$gcMark;
//  for(i=0;i<=sp;i++) {
//    work.push(stack[i]);
//  }
  traceGc("h$markThread: " + (Date.now()-start) + "ms");
  h$follow(stack, sp, work, weaks, null);
  h$resetThread(t);
}
/*
function h$followObj1(c, work) {
  work.push(c.d1);
}

function h$followObj7(c, work) {
  var d7=c.d2; work.push(c.d1, d7.d1, d7.d2, d7.d3, d7.d4, d7.d5, d7.d6);
}

function h$followObj6(c, work) {
  var d7=c.d2; work.push(c.d1, d7.d1, d7.d2, d7.d3, d7.d4, d7.d5);
}

function h$followObj5(c, work) {
  var d7=c.d2; work.push(c.d1, d7.d1, d7.d2, d7.d3, d7.d4);
}

function h$followObj4(c, work) {
  var d7=c.d2; work.push(c.d1, d7.d1, d7.d2, d7.d3);
}
*/
// big object, not handled by 0..7 cases
// keep out of h$follow to prevent deopt
function h$followObjGen(c, work) {
   work.push(c.d1);
   var d = c.d2;
   for(var x in d) {
//              if(d.hasOwnProperty(x)) {
     work.push(d[x]);
//              }
   }
}

function h$follow(stack, sp, work, weaks, ignore) {
  var start = Date.now();
  var mark = h$gcMark;
  if(stack === null) { sp = -1; }
  while(sp >= 0 || work.length > 0) {
    //traceGc(work.slice(-5).map(function(x) { if(typeof(x)==='object') { return h$collectProps(x).substring(0,40); } else {return (""+x).substring(0,40);}}));
    var c = (sp >= 0) ? stack[sp--] : work.pop();
    //traceGc("mark step: " + typeof c);
    if(c !== null && typeof c === 'object' && c !== ignore && (c.m === undefined || (c.m&3) !== mark)) {
      var doMark = false;
      var cf = c.f;
      if(cf !== undefined) { // c.f !== undefined && c.d1 !== undefined && c.d2 !== undefined) {
        // traceGc("marking heap obj: " + c.f.n + " tag: " + c.f.gtag);
        c.m = (c.m&-4)|mark;
        // dynamic references
        var d = c.d2;
        switch(cf.gtag) {
          case 0: break;
          case 1: work.push(c.d1); break;
          case 2: work.push(c.d1, d); break;
          case 3: var d3=c.d2; work.push(c.d1, d3.d1, d3.d2); break;
          case 4: var d4=c.d2; work.push(c.d1, d4.d1, d4.d2, d4.d3); break;
          case 5: var d5=c.d2; work.push(c.d1, d5.d1, d5.d2, d5.d3, d5.d4); break;
          case 6: var d6=c.d2; work.push(c.d1, d6.d1, d6.d2, d6.d3, d6.d4, d6.d5); break;
          case 7: var d7=c.d2; work.push(c.d1, d7.d1, d7.d2, d7.d3, d7.d4, d7.d5, d7.d6); break;
          case 8: var d8=c.d2; work.push(c.d1, d8.d1, d8.d2, d8.d3, d8.d4, d8.d5, d8.d6, d8.d7); break;
          case 9: var d9=c.d2; work.push(c.d1, d9.d1, d9.d2, d9.d3, d9.d4, d9.d5, d9.d6, d9.d7, d9.d8); break;
//          case 10: var d10=c.d2; work.push(c.d1, d10.d1, d10.d2, d10.d3, d10.d4, d10.d5, d10.d6, d10.d7, d10.d8, d10.d9); break;
//          case 11: var d11=c.d2; work.push(c.d1, d11.d1, d11.d2, d11.d3, d11.d4, d11.d5, d11.d6, d11.d7, d11.d8, d11.d9, d11.d10); break;
//          case 12: var d12=c.d2; work.push(c.d1, d12.d1, d12.d2, d12.d3, d12.d4, d12.d5, d12.d6, d12.d7, d12.d8, d12.d9, d12.d10, d12.d11); break;
          default: h$followObjGen(c,work);
        }
        // static references
        var s = cf.s;
        if(s !== null) {
          //traceGc("adding static marks:");
          //traceGc(s);
          // work.push.apply(work, s);
          for(var i=0;i<s.length;i++) { work.push(s[i]); }
        }
      } else if(c instanceof h$Thread) {
        //traceGc("marking thread or array");
        c.m = (c.m&-4)|mark;
      } else if(c instanceof h$Weak) {
        //traceGc("marking weak");
        weaks.push(c);
        c.m = (c.m&-4)|mark;
      } else if(c instanceof h$MVar) {
        //traceGc("marking mvar");
        c.m = (c.m&-4)|mark;
        work.push.apply(work, c.readers.getValues());
        work.push.apply(work, c.writers.getValues());
        if(c.val !== null) { work.push(c); }
      } else if(c instanceof h$MutVar) {
        //traceGc("marking mutvar");
        c.m = (c.m&-4)|mark;
        work.push(c.val);
      } else if(c instanceof DataView) {
        doMark = true;
      } else if(c instanceof Array) {
        //traceGc("marking array");
        doMark = true;
        for(var i=0;i<c.length;i++) {
          var x = c[i];
          if(x && typeof x === 'object' && (x.m === undefined || (x.m&3) !== mark)) {
            work.push(x);
          }
        }
      }
      // safe marking for when we don't know that c.m exists
      if(doMark) {
//        h$marked++;
        if(c.m === undefined) {
          c.m = mark;
        } else {
          c.m = (c.m&-4)|mark;
        }
      }
    }
  }
  traceGc("h$follow: " + (Date.now()-start) + "ms");
}

function h$resetThread(t) {
  var start = Date.now();
  var stack = t.stack;
  var sp = t.sp;
  if(stack.length - sp > sp && stack.length > 100) {
    t.stack = t.stack.slice(0,sp+1);
  } else {
    for(var i=sp+1;i<stack.length;i++) {
      stack[i] = null;
    }
  }
  traceGc("h$resetThread: " + (Date.now()-start) + "ms");
}

function h$finalizeCAFs(t) {
  if(h$retainCAFs) { return; }
  var start = Date.now();
  var mark = h$gcMark;
  for(var i=0;i<h$CAFs.length;i++) {
    var c = h$CAFs[i];
    if(c.m & 3 !== mark) {
      var cr = h$CAFsReset[i];
      if(c.f !== cr) { // has been updated, reset it
        traceGc("resetting CAF: " + cr.n);
        c.f = cr;
        c.d1 = null;
        c.d2 = null;
      }
    }
  }
  traceGc("h$finalizeCAFs: " + (Date.now()-start) + "ms");
}


// keep these values the same as "include/HsBaseConfig.h"
var h$E2BIG = 7;
var h$EBADF = 9;
var h$EACCES = 13;
var h$EINVAL = 22;
var h$EILSEQ = 92;

var h$errno = 0;

function h$__hscore_get_errno() {
//  log("### __hscore_get_errno: " + h$errno);
  return h$errno;
}

function h$strerror(err) {
  ret1 = 0;
  if(err === h$E2BIG) {
    return h$encodeUtf8("too big");
  } else if(err === h$EACCES) {
    return h$encodeUtf8("no access");
  } else if(err === h$EINVAL) {
    return h$encodeUtf8("invalid");
  } else if(err === h$EBADF) {
    return h$encodeUtf8("invalid file descriptor");
  } else {
    return h$encodeUtf8("unknown error");
  }
}



function h$MD5Init(ctx, ctx_off) {
  if(!ctx.arr) { ctx.arr = []; }
  ctx.arr[ctx_off] = new goog.crypt.Md5();
}
var h$__hsbase_MD5Init = h$MD5Init;

function h$MD5Update(ctx, ctx_off, data, data_off, len) {
  var arr = new Uint8Array(data.buf, data_off);
  ctx.arr[ctx_off].update(arr, len);
}
var h$__hsbase_MD5Update = h$MD5Update;

function h$MD5Final(dst, dst_off, ctx, ctx_off) {
  var digest = ctx.arr[ctx_off].digest();
  for(var i=0;i<16;i++) {
    dst.u8[dst_off+i] = digest[i];
  }
}
var h$__hsbase_MD5Final = h$MD5Final;

// var h$logArith = function() { log.apply(this,arguments); }
var h$logArith = function() { }

function h$hs_eqWord64(a1,a2,b1,b2) {
  return (a1===b1 && a2===b2) ? 1 : 0;
}

function h$hs_neWord64(a1,a2,b1,b2) {
  return (a1 !== b1 || a2 !== b2) ? 1 : 0;
}

function h$hs_word64ToWord(a1,a2) {
  return a2;
}

function h$hs_wordToWord64(w) {
  h$ret1 = w;
  return 0;
}

function h$hs_intToInt64(a) {
  h$ret1 = a;
  return (a < 0) ? -1 : 0;
}

function h$hs_int64ToWord64(a1,a2) {
  h$ret1 = a2;
  return a1;
}

function h$hs_word64ToInt64(a1,a2) {
  h$ret1 = a2;
  return a1;
}

function h$hs_int64ToInt(a1,a2) {
  return (a1 < 0) ? (a2 | 0x80000000) : (a2 & 0x7FFFFFFF);
}

function h$hs_negateInt64(a1,a2) {
  var c = goog.math.Long.fromBits(a2,a1).negate();
  h$ret1 = c.getLowBits();
  return c.getHighBits();
}

function h$hs_not64(a1,a2) {
  h$ret1 = ~a2;
  return ~a1;
}

function h$hs_xor64(a1,a2,b1,b2) {
  h$ret1 = a2 ^ b2;
  return a1 ^ b1;
}

function h$hs_and64(a1,a2,b1,b2) {
  h$ret1 = a2 & b2;
  return a1 & b1;
}

function h$hs_or64(a1,a2,b1,b2) {
  h$ret1 = a2 | b2;
  return a1 | b1;
}

function h$hs_eqInt64(a1,a2,b1,b2) {
  return (a1 === b1 && a2 === b2) ? 1 : 0;
}

function h$hs_neInt64(a1,a2,b1,b2) {
  return (a1 !== b1 || a2 !== b2) ? 1 : 0;
}

function h$hs_leInt64(a1,a2,b1,b2) {
  if(a1 === b1) {
    var a2s = a2 >>> 1;
    var b2s = b2 >>> 1;
    return (a2s < b2s || (a2s === b2s && ((a2&1) <= (b2&1)))) ? 1 : 0;
  } else {
    return (a1 < b1) ? 1 : 0;
  }
}

function h$hs_ltInt64(a1,a2,b1,b2) {
  if(a1 === b1) {
    var a2s = a2 >>> 1;
    var b2s = b2 >>> 1;
    return (a2s < b2s || (a2s === b2s && ((a2&1) < (b2&1)))) ? 1 : 0;
  } else {
    return (a1 < b1) ? 1 : 0;
  }
}

function h$hs_geInt64(a1,a2,b1,b2) {
  if(a1 === b1) {
    var a2s = a2 >>> 1;
    var b2s = b2 >>> 1;
    return (a2s > b2s || (a2s === b2s && ((a2&1) >= (b2&1)))) ? 1 : 0;
  } else {
    return (a1 > b1) ? 1 : 0;
  }
}

function h$hs_gtInt64(a1,a2,b1,b2) {
  if(a1 === b1) {
    var a2s = a2 >>> 1;
    var b2s = b2 >>> 1;
    return (a2s > b2s || (a2s === b2s && ((a2&1) > (b2&1)))) ? 1 : 0;
  } else {
    return (a1 > b1) ? 1 : 0;
  }
}

function h$hs_quotWord64(a1,a2,b1,b2) {
  var a = h$bigFromWord64(a1,a2);
  var b = h$bigFromWord64(b1,b2);
  var c = a.divide(b);
  h$ret1 = c.intValue();
  return c.shiftRight(32).intValue();
}

function h$hs_timesInt64(a1,a2,b1,b2) {
  var c = goog.math.Long.fromBits(a2,a1).multiply(goog.math.Long.fromBits(b2,b1));
  h$ret1 = c.getLowBits();
  return c.getHighBits();
}

function h$hs_quotInt64(a1,a2,b1,b2) {
  var c = goog.math.Long.fromBits(a2,a1).div(goog.math.Long.fromBits(b2,b1));
  h$ret1 = c.getLowBits();
  return c.getHighBits();
}

function h$hs_remInt64(a1,a2,b1,b2) {
  var c = goog.math.Long.fromBits(a2,a1).modulo(goog.math.Long.fromBits(b2,b1));
  h$ret1 = c.getLowBits();
  return c.getHighBits();
}

function h$hs_plusInt64(a1,a2,b1,b2) {
  var c = goog.math.Long.fromBits(a2,a1).add(goog.math.Long.fromBits(b2,b1));
  h$ret1 = c.getLowBits();
  return c.getHighBits();
}

function h$hs_minusInt64(a1,a2,b1,b2) {
  var c = goog.math.Long.fromBits(a2,a1).subtract(goog.math.Long.fromBits(b2,b1));
  h$ret1 = c.getLowBits();
  return c.getHighBits();
}

function h$hs_leWord64(a1,a2,b1,b2) {
  if(a1 === b1) {
    var a2s = a2 >>> 1;
    var b2s = b2 >>> 1;
    return (a2s < b2s || (a2s === b2s && ((a2&1) <= (b2&1)))) ? 1 : 0;
  } else {
    var a1s = a1 >>> 1;
    var b1s = b1 >>> 1;
    return (a1s < b1s || (a1s === b1s && ((a1&1) <= (b1&1)))) ? 1 : 0;
  }
}

function h$hs_ltWord64(a1,a2,b1,b2) {
  if(a1 === b1) {
    var a2s = a2 >>> 1;
    var b2s = b2 >>> 1;
    return (a2s < b2s || (a2s === b2s && ((a2&1) < (b2&1)))) ? 1 : 0;
  } else {
    var a1s = a1 >>> 1;
    var b1s = b1 >>> 1;
    return (a1s < b1s || (a1s === b1s && ((a1&1) < (b1&1)))) ? 1 : 0;
  }
}

function h$hs_geWord64(a1,a2,b1,b2) {
  if(a1 === b1) {
    var a2s = a2 >>> 1;
    var b2s = b2 >>> 1;
    return (a2s > b2s || (a2s === b2s && ((a2&1) >= (b2&1)))) ? 1 : 0;
  } else {
    var a1s = a1 >>> 1;
    var b1s = b1 >>> 1;
    return (a1s > b1s || (a1s === b1s && ((a1&1) >= (b1&1)))) ? 1 : 0;
  }
}

function h$hs_gtWord64(a1,a2,b1,b2) {
  if(a1 === b1) {
    var a2s = a2 >>> 1;
    var b2s = b2 >>> 1;
    return (a2s > b2s || (a2s === b2s && ((a2&1) > (b2&1)))) ? 1 : 0;
  } else {
    var a1s = a1 >>> 1;
    var b1s = b1 >>> 1;
    return (a1s > b1s || (a1s === b1s && ((a1&1) > (b1&1)))) ? 1 : 0;
  }
}

function h$hs_remWord64(a1,a2,b1,b2) {
  var a = h$bigFromWord64(a1,a2);
  var b = h$bigFromWord64(b1,b2);
  var c = a.mod(b);
  h$ret1 = c.intValue();
  return c.shiftRight(32).intValue();
}

function h$hs_uncheckedIShiftL64(a1,a2,n) {
  var num = new goog.math.Long(a2,a1).shiftLeft(n);
  h$ret1 = num.getLowBits();
  return num.getHighBits();
}

function h$hs_uncheckedIShiftRA64(a1,a2,n) {
  var num = new goog.math.Long(a2,a1).shiftRight(n);
  h$ret1 = num.getLowBits();
  return num.getHighBits();
}

// always nonnegative n?
function h$hs_uncheckedShiftL64(a1,a2,n) {
  n &= 63;
  if(n == 0) {
    h$ret1 = a2;
    return a1;
  } else if(n < 32) {
    h$ret1 = a2 << n;
    return (a1 << n) | (a2 >>> (32-n));
  } else {
    h$ret1 = 0;
    return ((a2 << (n-32))|0);
  }
}

function h$hs_uncheckedShiftRL64(a1,a2,n) {
  n &= 63;
  if(n == 0) {
    h$ret1 = a2;
    return a1;
  } else if(n < 32) {
    h$ret1 = (a2 >>> n ) | (a1 << (32-n));
    return a1 >>> n;
  } else {
    h$ret1 = a1 >>> (n-32);
    return 0;
  }
}

// fixme this function appears to deoptimize a lot due to smallint overflows
function h$imul_shim(a, b) {
    var ah  = (a >>> 16) & 0xffff;
    var al = a & 0xffff;
    var bh  = (b >>> 16) & 0xffff;
    var bl = b & 0xffff;
    // the shift by 0 fixes the sign on the high part
    // the final |0 converts the unsigned value into a signed value
    return (((al * bl)|0) + (((ah * bl + al * bh) << 16) >>> 0)|0);
}

var h$mulInt32 = Math.imul ? Math.imul : h$imul_shim;

// function h$mulInt32(a,b) {
//  return goog.math.Long.fromInt(a).multiply(goog.math.Long.fromInt(b)).getLowBits();
// }
// var hs_mulInt32 = h$mulInt32;

function h$mulWord32(a,b) {
  return goog.math.Long.fromBits(a,0).multiply(goog.math.Long.fromBits(b,0)).getLowBits();
}

function h$mul2Word32(a,b) {
  var c = goog.math.Long.fromBits(a,0).multiply(goog.math.Long.fromBits(b,0))
  h$ret1 = c.getLowBits();
  return c.getHighBits();
}

function h$quotWord32(a,b) {
  return goog.math.Long.fromBits(a,0).div(goog.math.Long.fromBits(b,0)).getLowBits();
}

function h$remWord32(a,b) {
  return goog.math.Long.fromBits(a,0).modulo(goog.math.Long.fromBits(b,0)).getLowBits();
}

function h$quotRem2Word32(a1,a2,b) {
  var a = h$bigFromWord64(a1,a2);
  var b = h$bigFromWord(b);
  var d = a.divide(b);
  h$ret1 = a.subtract(b.multiply(d)).intValue();
  return d.intValue();
}

function h$wordAdd2(a,b) {
  var c = goog.math.Long.fromBits(a,0).add(goog.math.Long.fromBits(b,0));
  h$ret1 = c.getLowBits();
  return c.getHighBits();
}

// this does an unsigned shift, is that ok?
function h$uncheckedShiftRL64(a1,a2,n) {
  if(n < 0) throw "unexpected right shift";
  n &= 63;
  if(n == 0) {
    h$ret1 = a2;
    return a1;
  } else if(n < 32) {
    h$ret1 = (a2 >>> n) | (a1 << (32 - n));
    return (a1 >>> n);
  } else {
    h$ret1 = a2 >>> (n - 32);
    return 0;
  }
}

function h$isDoubleNegativeZero(d) {
  return (d===0 && (1/d) === -Infinity) ? 1 : 0;
}

function h$isFloatNegativeZero(d) {
  return (d===0 && (1/d) === -Infinity) ? 1 : 0;
}

function h$isDoubleInfinite(d) {
  return (d === Number.NEGATIVE_INFINITY || d === Number.POSITIVE_INFINITY) ? 1 : 0;
}

function h$isFloatInfinite(d) {
  return (d === Number.NEGATIVE_INFINITY || d === Number.POSITIVE_INFINITY) ? 1 : 0;
}

function h$isFloatFinite(d) {
  return (d !== Number.NEGATIVE_INFINITY && d !== Number.POSITIVE_INFINITY && !isNaN(d)) ? 1 : 0;
}

function h$isDoubleFinite(d) {
  return (d !== Number.NEGATIVE_INFINITY && d !== Number.POSITIVE_INFINITY && !isNaN(d)) ? 1 : 0;
}

function h$isDoubleNaN(d) {
  return (isNaN(d)) ? 1 : 0;
}

function h$isFloatNaN(d) {
  return (isNaN(d)) ? 1 : 0;
}

function h$isDoubleDenormalized(d) {
  return (d !== 0 && Math.abs(d) < 2.2250738585072014e-308) ? 1 : 0;
}

function h$isFloatDenormalized(d) {
  return (d !== 0 && Math.abs(d) < 2.2250738585072014e-308) ? 1 : 0;
}

function h$decodeFloatInt(d) {
    if(isNaN(d)) {
      h$ret1 = 105;
      return -12582912;
    }
    var exponent    = h$integer_cmm_decodeDoublezh(d)+29;
    var significand = h$ret2.shiftRight(29).intValue();
    if(exponent > 105) {
      exponent = 105;
      significand = significand > 0 ? 8388608 : -8388608;
    } else if(exponent < -151) {
      significand = 0;
      exponent = 0;
    }
    h$ret1 = exponent;
    return significand;
}

function h$decodeDouble2Int(d) {
   var exponent    = h$integer_cmm_decodeDoublezh(d);
   var significand = h$ret2;
   var sign = d<0?-1:1;
   h$ret1 = significand.shiftRight(32).intValue(); // correct sign?
   h$ret2 = significand.intValue();
   return sign;
}

// round .5 to nearest even number
function h$rintDouble(a) {
  var rounda = Math.round(a);
  if(a >= 0) {
    if(a%1===0.5 && rounda%2===1) { // tie
      return rounda-1;
    } else {
      return rounda;
    }
  } else {
    if(a%1===-0.5 && rounda%2===-1) { // tie
      return rounda-1;
    } else {
      return rounda;
    }
  }
}
var h$rintFloat = h$rintDouble;

function h$acos(d) { return Math.acos(d); }
function h$acosf(f) { return Math.acos(f); }

function h$asin(d) { return Math.asin(d); }
function h$asinf(f) { return Math.asin(f); }

function h$atan(d) { return Math.atan(d); }
function h$atanf(f) { return Math.atan(f); }

function h$atan2(x,y) { return Math.atan2(x,y); }
function h$atan2f(x,y) { return Math.atan2(x,y); }

function h$cos(d) { return Math.cos(d); }
function h$cosf(f) { return Math.cos(f); }

function h$sin(d) { return Math.sin(d); }
function h$sinf(f) { return Math.sin(f); }

function h$tan(d) { return Math.tan(d); }
function h$tanf(f) { return Math.tan(f); }

function h$cosh(d) { return (Math.exp(d)+Math.exp(-d))/2; }
function h$coshf(f) { return h$cosh(f); }

function h$sinh(d) { return (Math.exp(d)-Math.exp(-d))/2; }
function h$sinhf(f) { return h$sinh(f); }

function h$tanh(d) { return (Math.exp(2*d)-1)/(Math.exp(2*d)+1); }
function h$tanhf(f) { return h$tanh(f); }

var h$popCntTab =
   [0,1,1,2,1,2,2,3,1,2,2,3,2,3,3,4,1,2,2,3,2,3,3,4,2,3,3,4,3,4,4,5,
    1,2,2,3,2,3,3,4,2,3,3,4,3,4,4,5,2,3,3,4,3,4,4,5,3,4,4,5,4,5,5,6,
    1,2,2,3,2,3,3,4,2,3,3,4,3,4,4,5,2,3,3,4,3,4,4,5,3,4,4,5,4,5,5,6,
    2,3,3,4,3,4,4,5,3,4,4,5,4,5,5,6,3,4,4,5,4,5,5,6,4,5,5,6,5,6,6,7,
    1,2,2,3,2,3,3,4,2,3,3,4,3,4,4,5,2,3,3,4,3,4,4,5,3,4,4,5,4,5,5,6,
    2,3,3,4,3,4,4,5,3,4,4,5,4,5,5,6,3,4,4,5,4,5,5,6,4,5,5,6,5,6,6,7,
    2,3,3,4,3,4,4,5,3,4,4,5,4,5,5,6,3,4,4,5,4,5,5,6,4,5,5,6,5,6,6,7,
    3,4,4,5,4,5,5,6,4,5,5,6,5,6,6,7,4,5,5,6,5,6,6,7,5,6,6,7,6,7,7,8];

function h$popCnt32(x) {
   return h$popCntTab[x&0xFF] +
          h$popCntTab[(x>>>8)&0xFF] +
          h$popCntTab[(x>>>16)&0xFF] +
          h$popCntTab[(x>>>24)&0xFF]
}

function h$popCnt64(x1,x2) {
   return h$popCntTab[x1&0xFF] +
          h$popCntTab[(x1>>>8)&0xFF] +
          h$popCntTab[(x1>>>16)&0xFF] +
          h$popCntTab[(x1>>>24)&0xFF] +
          h$popCntTab[x2&0xFF] +
          h$popCntTab[(x2>>>8)&0xFF] +
          h$popCntTab[(x2>>>16)&0xFF] +
          h$popCntTab[(x2>>>24)&0xFF];
}

function h$bswap64(x1,x2) {
  h$ret1 = (x1 >>> 24) | (x1 << 24) | ((x1 & 0xFF00) << 8) | ((x1 & 0xFF0000) >> 8);
  return   (x2 >>> 24) | (x2 << 24) | ((x2 & 0xFF00) << 8) | ((x2 & 0xFF0000) >> 8);
}


function h$stdFd(n,readReady,writeReady,buf) {
  return new h$Fd(buf, readReady, writeReady, n);
}

var h$stdinBuf = { write: function() { throw "can't write to stdin"; } };
var h$stdoutBuf = { read: function() { throw "can't read from stdout"; } };
var h$stderrBuf = { read: function () { throw "can't read from stderr"; } };

function h$initStdioBufs() {
  if(typeof process !== 'undefined' && process && process.stdin) { // node.js
    h$stdinBuf.isATTY  = process.stdin.isTTY;
    h$stdoutBuf.isATTY = process.stdout.isTTY;
    h$stderrBuf.isATTY = process.stderr.isTTY;

    // stdin
    h$stdinBuf.chunks = new goog.structs.Queue();
    h$stdinBuf.chunkOff = 0;
    h$stdinBuf.eof = false;
    h$stdinBuf.readReady = false;
    h$stdinBuf.writeReady = false;
    process.stdin.on('data', function(chunk) {
      h$stdinBuf.chunks.enqueue(chunk);
      h$stdin.readReady = true;
      h$notifyRead(h$stdin);
    });
    process.stdin.on('end', function() {
      h$stdinBuf.eof = true;
      h$stdin.readReady = true; // for eof, the fd is ready but read returns 0 bytes
      h$notifyRead(h$stdin);
    });
    h$stdinBuf.read = function(fd, buf, buf_offset, n) {
      if(fd.buf.chunks.getCount() === 0) {
        return 0;
      } else {
        var h = fd.buf.chunks.peek();
        var o = fd.buf.chunkOff;
        var left = h.length - o;
        var u8 = buf.u8;
        if(left > n) {
          for(var i=0;i<n;i++) {
            u8[buf_offset+i] = h[o+i];
          }
          fd.buf.chunkOff += n;
          return n;
        } else {
          for(var i=0;i<left;i++) {
            u8[buf_offset+i] = h[o+i];
          }
          fd.buf.chunkOff = 0;
          fd.buf.chunks.dequeue();
          if(fd.buf.chunks.getCount() === 0 && !fd.buf.eof) {
            h$stdin.readReady = false;
          }
          return left;
        }
      }
    }

    // stdout, stderr
    h$stdoutBuf.write  = function(fd, buf, buf_offset, n) {
      process.stdout.write(h$decodeUtf8(buf, n, buf_offset));
      return n;
    };
    h$stderrBuf.write  = function(fd, buf, buf_offset, n) {
      process.stderr.write(h$decodeUtf8(buf, n, buf_offset));
      return n;
    };
  } else if(typeof putstr !== 'undefined') { // SpiderMonkey
    h$stdoutBuf.isATTY = true;
    h$stderrBuf.isATTY = true;
    h$stdinBuf.isATTY = false;
    h$stdinBuf.readReady = true;
    h$stdinBuf.read = function() { return 0; } // eof
    h$stdoutBuf.write = function(fd, buf, buf_offset, n) {
      putstr(h$decodeUtf8(buf, n, buf_offset));
      return n;
    }
    h$stderrBuf.write = function(fd, buf, buf_offset, n) {
      printErr(h$decodeUtf8(buf, n, buf_offset)); // prints too many newlines
      return n;
    }
  } else { // browser or fallback
    h$stdoutBuf.isATTY = true;
    h$stderrBuf.isATTY = true;
    h$stdinBuf.isATTY = false;
    h$stdinBuf.readReady = true;
    h$stdinBuf.read = function() { return 0; } // eof
    var writeConsole = function(fd, buf, buf_offset, n) {
      if(typeof console !== 'undefined' && console && console.log) {
        console.log(h$decodeUtf8(buf, n, buf_offset));
      }
      return n;
    }
    h$stdoutBuf.write = writeConsole;
    h$stderrBuf.write = writeConsole;
  }
}
h$initStdioBufs();

var h$stdin  = h$stdFd(0, false, false, h$stdinBuf);
var h$stdout = h$stdFd(1, false, true, h$stdoutBuf);
var h$stderr = h$stdFd(2, false, true, h$stderrBuf);

var h$fdN = 3;
var h$fds = { '0': h$stdin
            , '1': h$stdout
            , '2': h$stderr
            };

var h$filesMap = {}; // new Map(); // path -> file

// fixme remove file from h$filesMap?
function h$close(fd) {
  var f = h$fds[fd];
  if(f) {
    for(var i=0;i<f.waitRead.length;i++) {
      h$throwTo(f.waitRead[i], h$IOException);
    }
    for(var i=0;i<f.waitWrite.length;i++) {
      h$throwTo(f.waitWrite[i], h$IOException);
    }
    delete h$fds[fd];
    return 0;
  } else {
    h$errno = h$EBADF;
    return -1;
  }
}

function h$Fd(buf, readReady, writeReady, isATTY, n) {
  if(n !== undefined) {
    this.fd = n;
  } else {
    this.fd  = h$fdN++;
  }
  this.pos = 0;
  this.buf = buf;
  this.waitRead = [];
  this.waitWrite = [];
  this.readReady = readReady;
  this.writeReady = writeReady;
  this.isATTY = isATTY;
}

function h$newFd(file) {
  var fd = new h$Fd(file, true, true, false);
  h$fds[fd.fd] = fd;
  return fd;
}

function h$newFile(path, data) {
  var f = { path: path
          , data: data
          , len: data.len // number of bytes in the file (might be smaller than data.len later)
          , read: h$readFile
          , write: h$writeFile
          , isATTY: false
          };
  h$filesMap[path] = f;
  return f;
}

// notify threads waiting, call after new data for fd comes in
function h$notifyRead(fd) {
  var a = fd.waitRead;
  for(var i=0;i<a.length;i++) {
    h$wakeupThread(a[i]);
  }
  a.length = 0;
}

// notify threads waiting, call when we can write more
function h$notifyWrite(fd) {
  var a = fd.waitWrite;
  for(var i=0;i<a.length;i++) {
    h$wakupThread(a[i]);
  }
  fd.waitRead.length = 0;
}

function h$readFile() {

}

// use the system specific way to load the file (either AJAX or directly)
// return a buffer with the contents
function h$loadFileData(path) {
  if(path.charCodeAt(path.length-1) === 0) {
    path = path.substring(0,path.length-1);
  }
  if(typeof h$nodeFs !== 'undefined' && h$nodeFs.readFileSync) { // node.js
    return h$fromNodeBuffer(h$nodeFs.readFileSync(path));
  } else if(typeof snarf !== 'undefined') { // SpiderMonkey
    return new h$wrapBuffer(snarf(path, "binary").buffer, false);
  } else {
    var url = h$pathUrl(path);
    var transport = new XMLHttpRequest();
    transport.open("GET", url, false);
    transport.responseType = "arraybuffer";
    transport.send();
    if(transport.status == 200 || transport.status == 0) {
      return h$wrapBuffer(transport.response, false);
    } else {
      return null; // fixme proper error
    }
  }
}

// node buffer to GHCJS buffer
function h$fromNodeBuffer(buf) {
  var l = buf.length;
  var buf2 = new ArrayBuffer(l);
  var u8 = new Uint8Array(buf2);
  for(var i=0;i<l;i++) {
    u8[i] = buf[i];
  }
  return h$wrapBuffer(buf2, false);
}

function h$pathUrl(path) {
  log("path url: " + path);
  return("://" + path);
}

function h$findFile(path) {
  return h$filesMap[path];
}

function h$isatty(d) {
  return h$fds[d].buf.isATTY?1:0;
}

function h$__hscore_bufsiz() { return 4096; }
function h$__hscore_seek_set() { return 0; }
function h$__hscore_seek_cur() { return 1; }
function h$__hscore_seek_end() { return 2; }

function h$__hscore_o_binary() { return 0; }
function h$__hscore_o_rdonly() { return 0; }
function h$__hscore_o_wronly() { return 0x0001; }
function h$__hscore_o_rdwr() { return 0x0002; }
function h$__hscore_o_append() { return 0x0008; }
function h$__hscore_o_creat() { return 0x0200; }
function h$__hscore_o_excl() { return 0x0800; }
function h$__hscore_o_trunc() { return 0x0400; }
function h$__hscore_o_noctty() { return 0x20000; }
function h$__hscore_o_nonblock() { return 0x0004; }
function h$__hscore_s_isdir() { return 0; }
function h$__hscore_s_isfifo() { return 0; }
function h$__hscore_s_isblk() { return 0; }
function h$__hscore_s_ischr() { return 0; }
function h$__hscore_s_issock() { return 0; }
function h$__hscore_s_isreg() { return 1; }

// fixme support some actual mode bits?
function h$S_ISDIR(mode) { return 0; }
function h$S_ISFIFO(mode) { return 0; }
function h$S_ISBLK(mode) { return 0; }
function h$S_ISCHR(mode) { return 0; }
function h$S_ISSOCK(mode) { return 0; }
function h$S_ISREG(mode) { return 1; }

/*
 partial fstat emulation, only set the size
 */
function h$__hscore_sizeof_stat() { return 4; }
function h$__hscore_fstat(fd, buf, off) {
  var f = h$fds[fd];
  // log('__hscore_fstat: (bytelen): ' + f.buf.len);
  buf.dv.setUint32(off, f.buf.len, true);
  return 0;
}
function h$__hscore_st_mode(st) { return 0; }
function h$__hscore_st_dev() { return 0; }
function h$__hscore_st_ino() { return 0; }
function h$__hscore_st_size(st, off) {
    // return 64 bit
    h$ret1 = st.dv.getInt32(off, true);
    return 0;
}

function h$__hscore_open(filename, filename_off, h, mode) {
    var p = h$decodeUtf8(filename, filename_off);
    // log('__hscore_open '+p);
    var f = h$findFile(p);
    if(!f) {
      var d = h$loadFileData(p);
      var file = h$newFile(p,d);
      return h$newFd(file).fd;
    } else {
      return h$newFd(f).fd;
    }
}

function h$lseek(fd, offset1, offset2, whence) {
  var offset = goog.math.Long.fromBits(offset2,offset1).toNumber();
  // log("### lseek: " + fd + ", " + offset + ", " + whence);
  var f = h$fds[fd];
  if(!f) {
    h$errno = h$EBADF;
    return -1;
  }
  var newOff;
  if(whence === 0) { // seek_set
    newOff = offset;
  } else if(whence === 1) { // seek_cur
    newOff = f.pos + offset;
  } else if(whence === 2) { // seek_end
    newOff = f.buf.len + offset;
  } else {
    h$errno = h$EINVAL;
    return -1;
  }
  if(newOff < 0) {
    h$errno = h$EINVAL;
    return -1;
  } else {
    f.pos = newOff;
    var no = goog.math.Long.fromNumber(newOff);
    h$ret1 = no.getLowBits();
    return no.getHighBits();
  }
}

function h$SEEK_SET() { return 0; }
function h$SEEK_CUR() { return 1; }
function h$SEEK_END() { return 2; }

var h$baseZCSystemziPosixziInternalsZClseek = h$lseek;
var h$baseZCSystemziPosixziInternalsZCSEEKzuCUR = h$__hscore_seek_cur;
var h$baseZCSystemziPosixziInternalsZCSEEKzuSET = h$__hscore_seek_set;
var h$baseZCSystemziPosixziInternalsZCSEEKzuEND = h$__hscore_seek_end;
var h$baseZCSystemziPosixziInternalsZCSzuISDIR = h$__hscore_s_isdir;
var h$baseZCSystemziPosixziInternalsZCSzuISFIFO = h$__hscore_s_isfifo;
var h$baseZCSystemziPosixziInternalsZCSzuISSOCK = h$__hscore_s_issock;
var h$baseZCSystemziPosixziInternalsZCSzuISCHR = h$__hscore_s_ischr;
var h$baseZCSystemziPosixziInternalsZCSzuISREG = h$__hscore_s_isreg;
var h$baseZCSystemziPosixziInternalsZCread = h$read;

function h$lockFile(fd, dev, ino, for_writing) {
//    log("### lockFile");
    return 0;
}
function h$unlockFile(fd) {
//    log("### unlockFile");
    return 0;
}
function h$fdReady(fd, write, msecs, isSock) {
  var f = h$fds[fd];
  if(write) {
    if(f.writeReady) {
      return 1;
    } else if(msecs === 0) {
      return 0;
    } else {
      throw "h$fdReady: blocking not implemented";
    }
  } else {
    if(f.readReady) {
      return 1;
    } else if(msecs === 0) {
      return 0;
    } else {
      throw "h$fdReady: blocking not implemented";
    }
  }
}

function h$write(fd, buf, buf_offset, n) {
//  log("h$write: fd: " + fd + " (" + n + ")");
  var f = h$fds[fd];
  return f.buf.write(f, buf, buf_offset, n);
}

function h$read(fd, buf, buf_offset, n) {
//  log("h$read: fd: " + fd + " (" + n + ")");
  var f = h$fds[fd];
  return f.buf.read(f, buf, buf_offset, n);
}

var h$baseZCSystemziPosixziInternalsZCwrite = h$write;

function h$readFile(fd, buf, buf_offset, n) {
//  log("h$readFile: " + n);
  var fbuf = fd.buf.data;
  var pos = fd.pos;
  n = Math.min(n, fd.buf.len - pos);
  for(var i=0;i<n;i++) {
    buf.u8[buf_offset+i] = fbuf.u8[pos+i];
  }
  fd.pos += n;
//  log("h$readFile read: " + n);
  return n;
}

// write file just in memory
function h$writeFile(fd, buf, buf_offset, n) {
  // log("h$writeFile write: " + n + " old pos: " + fd.pos + " len: " + fd.buf.len);
  if(fd.pos + n > fd.buf.data.len) {
    var od = fd.buf.data;
    var d = h$newByteArray(Math.round(1.3*od.len)+100);
    var u8 = d.u8;
    var u8od = od.u8;
    for(var i=0;i<od.len;i++) {
      u8[i] = u8od[i];
    }
    fd.buf.data = d;
  }
  var offset = buf_offset + fd.pos;
  var bd = fd.buf.data;
  var u8 = bd.u8;
  var u8buf = buf.u8;
  for(var i=0;i<n;i++) {
    u8[offset+i] = u8buf[buf_offset+i];
  }
  fd.pos += n;
  fd.buf.len = Math.max(fd.buf.len, fd.pos);
  return n;
}



var h$printRanges = [32,95,160,13,174,714,890,5,900,7,908,1,910,20,931,389,1329,38,1369,7,1377,39,1417,2,1425,55,1488,27,1520,5,1542,22,1566,191,1758,48,1808,59,1869,101,1984,59,2048,46,2096,15,2112,28,2142,1,2304,120,2425,7,2433,3,2437,8,2447,2,2451,22,2474,7,2482,1,2486,4,2492,9,2503,2,2507,4,2519,1,2524,2,2527,5,2534,22,2561,3,2565,6,2575,2,2579,22,2602,7,2610,2,2613,2,2616,2,2620,1,2622,5,2631,2,2635,3,2641,1,2649,4,2654,1,2662,16,2689,3,2693,9,2703,3,2707,22,2730,7,2738,2,2741,5,2748,10,2759,3,2763,3,2768,1,2784,4,2790,10,2801,1,2817,3,2821,8,2831,2,2835,22,2858,7,2866,2,2869,5,2876,9,2887,2,2891,3,2902,2,2908,2,2911,5,2918,18,2946,2,2949,6,2958,3,2962,4,2969,2,2972,1,2974,2,2979,2,2984,3,2990,12,3006,5,3014,3,3018,4,3024,1,3031,1,3046,21,3073,3,3077,8,3086,3,3090,23,3114,10,3125,5,3133,8,3142,3,3146,4,3157,2,3160,2,3168,4,3174,10,3192,8,3202,2,3205,8,3214,3,3218,23,3242,10,3253,5,3260,9,3270,3,3274,4,3285,2,3294,1,3296,4,3302,10,3313,2,3330,2,3333,8,3342,3,3346,41,3389,8,3398,3,3402,5,3415,1,3424,4,3430,16,3449,7,3458,2,3461,18,3482,24,3507,9,3517,1,3520,7,3530,1,3535,6,3542,1,3544,8,3570,3,3585,58,3647,29,3713,2,3716,1,3719,2,3722,1,3725,1,3732,4,3737,7,3745,3,3749,1,3751,1,3754,2,3757,13,3771,3,3776,5,3782,1,3784,6,3792,10,3804,2,3840,72,3913,36,3953,39,3993,36,4030,15,4046,13,4096,198,4304,45,4352,329,4682,4,4688,7,4696,1,4698,4,4704,41,4746,4,4752,33,4786,4,4792,7,4800,1,4802,4,4808,15,4824,57,4882,4,4888,67,4957,32,4992,26,5024,85,5120,669,5792,81,5888,13,5902,7,5920,23,5952,20,5984,13,5998,3,6002,2,6016,52,6070,40,6112,10,6128,10,6144,15,6160,10,6176,88,6272,43,6320,70,6400,29,6432,12,6448,12,6464,1,6468,42,6512,5,6528,44,6576,26,6608,11,6622,62,6686,65,6752,29,6783,11,6800,10,6816,14,6912,76,6992,45,7040,43,7086,12,7104,52,7164,60,7227,15,7245,51,7376,35,7424,231,7676,282,7960,6,7968,38,8008,6,8016,8,8025,1,8027,1,8029,1,8031,31,8064,53,8118,15,8134,14,8150,6,8157,19,8178,3,8182,9,8192,11,8208,24,8239,49,8304,2,8308,27,8336,13,8352,26,8400,33,8448,138,8592,612,9216,39,9280,11,9312,672,9985,202,10188,1,10190,895,11088,10,11264,47,11312,47,11360,146,11513,45,11568,54,11631,2,11647,24,11680,7,11688,7,11696,7,11704,7,11712,7,11720,7,11728,7,11736,7,11744,82,11904,26,11931,89,12032,214,12272,12,12288,64,12353,86,12441,103,12549,41,12593,94,12688,43,12736,36,12784,47,12832,223,13056,6838,19904,21004,40960,1165,42128,55,42192,348,42560,52,42620,28,42656,88,42752,143,42896,2,42912,10,43002,50,43056,10,43072,56,43136,69,43214,12,43232,28,43264,84,43359,30,43392,78,43471,11,43486,2,43520,55,43584,14,43600,10,43612,32,43648,67,43739,5,43777,6,43785,6,43793,6,43808,7,43816,7,43968,46,44016,10,44032,11172,55216,23,55243,49,63744,302,64048,62,64112,106,64256,7,64275,5,64285,26,64312,5,64318,1,64320,2,64323,2,64326,124,64467,365,64848,64,64914,54,65008,14,65024,26,65056,7,65072,35,65108,19,65128,4,65136,5,65142,135,65281,190,65474,6,65482,6,65490,6,65498,3,65504,7,65512,7,65532,2,65536,12,65549,26,65576,19,65596,2,65599,15,65616,14,65664,123,65792,3,65799,45,65847,84,65936,12,66000,46,66176,29,66208,49,66304,31,66336,4,66352,27,66432,30,66463,37,66504,14,66560,158,66720,10,67584,6,67592,1,67594,44,67639,2,67644,1,67647,23,67671,9,67840,28,67871,27,67903,1,68096,4,68101,2,68108,8,68117,3,68121,27,68152,3,68159,9,68176,9,68192,32,68352,54,68409,29,68440,27,68472,8,68608,73,69216,31,69632,78,69714,30,69760,61,69822,4,73728,879,74752,99,74864,4,77824,1071,92160,569,110592,2,118784,246,119040,39,119081,74,119163,99,119296,70,119552,87,119648,18,119808,85,119894,71,119966,2,119970,1,119973,2,119977,4,119982,12,119995,1,119997,7,120005,65,120071,4,120077,8,120086,7,120094,28,120123,4,120128,5,120134,1,120138,7,120146,340,120488,292,120782,50,126976,44,127024,100,127136,15,127153,14,127169,15,127185,15,127232,11,127248,31,127280,58,127344,43,127462,29,127504,43,127552,9,127568,2,127744,33,127792,6,127799,70,127872,20,127904,37,127942,5,127968,17,128000,63,128064,1,128066,182,128249,4,128256,62,128336,24,128507,5,128513,16,128530,3,128534,1,128536,1,128538,1,128540,3,128544,6,128552,4,128557,1,128560,4,128565,12,128581,11,128640,70,128768,116,131072,42711,173824,4149,177984,222,194560,542];
var h$alnumRanges = [48,10,65,26,97,26,170,1,178,2,181,1,185,2,188,3,192,23,216,31,248,458,710,12,736,5,748,1,750,1,768,117,886,2,890,4,902,1,904,3,908,1,910,20,931,83,1015,139,1155,165,1329,38,1369,1,1377,39,1425,45,1471,1,1473,2,1476,2,1479,1,1488,27,1520,3,1552,11,1568,74,1646,102,1749,8,1759,10,1770,19,1791,1,1808,59,1869,101,1984,54,2042,1,2048,46,2112,28,2304,100,2406,10,2417,7,2425,7,2433,3,2437,8,2447,2,2451,22,2474,7,2482,1,2486,4,2492,9,2503,2,2507,4,2519,1,2524,2,2527,5,2534,12,2548,6,2561,3,2565,6,2575,2,2579,22,2602,7,2610,2,2613,2,2616,2,2620,1,2622,5,2631,2,2635,3,2641,1,2649,4,2654,1,2662,16,2689,3,2693,9,2703,3,2707,22,2730,7,2738,2,2741,5,2748,10,2759,3,2763,3,2768,1,2784,4,2790,10,2817,3,2821,8,2831,2,2835,22,2858,7,2866,2,2869,5,2876,9,2887,2,2891,3,2902,2,2908,2,2911,5,2918,10,2929,7,2946,2,2949,6,2958,3,2962,4,2969,2,2972,1,2974,2,2979,2,2984,3,2990,12,3006,5,3014,3,3018,4,3024,1,3031,1,3046,13,3073,3,3077,8,3086,3,3090,23,3114,10,3125,5,3133,8,3142,3,3146,4,3157,2,3160,2,3168,4,3174,10,3192,7,3202,2,3205,8,3214,3,3218,23,3242,10,3253,5,3260,9,3270,3,3274,4,3285,2,3294,1,3296,4,3302,10,3313,2,3330,2,3333,8,3342,3,3346,41,3389,8,3398,3,3402,5,3415,1,3424,4,3430,16,3450,6,3458,2,3461,18,3482,24,3507,9,3517,1,3520,7,3530,1,3535,6,3542,1,3544,8,3570,2,3585,58,3648,15,3664,10,3713,2,3716,1,3719,2,3722,1,3725,1,3732,4,3737,7,3745,3,3749,1,3751,1,3754,2,3757,13,3771,3,3776,5,3782,1,3784,6,3792,10,3804,2,3840,1,3864,2,3872,20,3893,1,3895,1,3897,1,3902,10,3913,36,3953,20,3974,18,3993,36,4038,1,4096,74,4176,78,4256,38,4304,43,4348,1,4352,329,4682,4,4688,7,4696,1,4698,4,4704,41,4746,4,4752,33,4786,4,4792,7,4800,1,4802,4,4808,15,4824,57,4882,4,4888,67,4957,3,4969,20,4992,16,5024,85,5121,620,5743,17,5761,26,5792,75,5870,3,5888,13,5902,7,5920,21,5952,20,5984,13,5998,3,6002,2,6016,52,6070,30,6103,1,6108,2,6112,10,6128,10,6155,3,6160,10,6176,88,6272,43,6320,70,6400,29,6432,12,6448,12,6470,40,6512,5,6528,44,6576,26,6608,11,6656,28,6688,63,6752,29,6783,11,6800,10,6823,1,6912,76,6992,10,7019,9,7040,43,7086,12,7104,52,7168,56,7232,10,7245,49,7376,3,7380,31,7424,231,7676,282,7960,6,7968,38,8008,6,8016,8,8025,1,8027,1,8029,1,8031,31,8064,53,8118,7,8126,1,8130,3,8134,7,8144,4,8150,6,8160,13,8178,3,8182,7,8304,2,8308,6,8319,11,8336,13,8400,33,8450,1,8455,1,8458,10,8469,1,8473,5,8484,1,8486,1,8488,1,8490,4,8495,11,8508,4,8517,5,8526,1,8528,58,9312,60,9450,22,10102,30,11264,47,11312,47,11360,133,11499,7,11517,1,11520,38,11568,54,11631,1,11647,24,11680,7,11688,7,11696,7,11704,7,11712,7,11720,7,11728,7,11736,7,11744,32,11823,1,12293,3,12321,15,12337,5,12344,5,12353,86,12441,2,12445,3,12449,90,12540,4,12549,41,12593,94,12690,4,12704,27,12784,16,12832,10,12881,15,12928,10,12977,15,13312,6582,19968,20940,40960,1165,42192,46,42240,269,42512,28,42560,51,42620,2,42623,25,42656,82,42775,9,42786,103,42891,4,42896,2,42912,10,43002,46,43056,6,43072,52,43136,69,43216,10,43232,24,43259,1,43264,46,43312,36,43360,29,43392,65,43471,11,43520,55,43584,14,43600,10,43616,23,43642,2,43648,67,43739,3,43777,6,43785,6,43793,6,43808,7,43816,7,43968,43,44012,2,44016,10,44032,11172,55216,23,55243,49,63744,302,64048,62,64112,106,64256,7,64275,5,64285,12,64298,13,64312,5,64318,1,64320,2,64323,2,64326,108,64467,363,64848,64,64914,54,65008,12,65024,16,65056,7,65136,5,65142,135,65296,10,65313,26,65345,26,65382,89,65474,6,65482,6,65490,6,65498,3,65536,12,65549,26,65576,19,65596,2,65599,15,65616,14,65664,123,65799,45,65856,57,65930,1,66045,1,66176,29,66208,49,66304,31,66336,4,66352,27,66432,30,66464,36,66504,8,66513,5,66560,158,66720,10,67584,6,67592,1,67594,44,67639,2,67644,1,67647,23,67672,8,67840,28,67872,26,68096,4,68101,2,68108,8,68117,3,68121,27,68152,3,68159,9,68192,31,68352,54,68416,22,68440,27,68472,8,68608,73,69216,31,69632,71,69714,30,69760,59,73728,879,74752,99,77824,1071,92160,569,110592,2,119141,5,119149,6,119163,8,119173,7,119210,4,119362,3,119648,18,119808,85,119894,71,119966,2,119970,1,119973,2,119977,4,119982,12,119995,1,119997,7,120005,65,120071,4,120077,8,120086,7,120094,28,120123,4,120128,5,120134,1,120138,7,120146,340,120488,25,120514,25,120540,31,120572,25,120598,31,120630,25,120656,31,120688,25,120714,31,120746,25,120772,8,120782,50,127232,11,131072,42711,173824,4149,177984,222,194560,542];
var h$lowerRanges = [97,26,170,1,181,1,186,1,223,24,248,8,257,1,259,1,261,1,263,1,265,1,267,1,269,1,271,1,273,1,275,1,277,1,279,1,281,1,283,1,285,1,287,1,289,1,291,1,293,1,295,1,297,1,299,1,301,1,303,1,305,1,307,1,309,1,311,2,314,1,316,1,318,1,320,1,322,1,324,1,326,1,328,2,331,1,333,1,335,1,337,1,339,1,341,1,343,1,345,1,347,1,349,1,351,1,353,1,355,1,357,1,359,1,361,1,363,1,365,1,367,1,369,1,371,1,373,1,375,1,378,1,380,1,382,3,387,1,389,1,392,1,396,2,402,1,405,1,409,3,414,1,417,1,419,1,421,1,424,1,426,2,429,1,432,1,436,1,438,1,441,2,445,3,454,1,457,1,460,1,462,1,464,1,466,1,468,1,470,1,472,1,474,1,476,2,479,1,481,1,483,1,485,1,487,1,489,1,491,1,493,1,495,2,499,1,501,1,505,1,507,1,509,1,511,1,513,1,515,1,517,1,519,1,521,1,523,1,525,1,527,1,529,1,531,1,533,1,535,1,537,1,539,1,541,1,543,1,545,1,547,1,549,1,551,1,553,1,555,1,557,1,559,1,561,1,563,7,572,1,575,2,578,1,583,1,585,1,587,1,589,1,591,69,661,27,881,1,883,1,887,1,891,3,912,1,940,35,976,2,981,3,985,1,987,1,989,1,991,1,993,1,995,1,997,1,999,1,1001,1,1003,1,1005,1,1007,5,1013,1,1016,1,1019,2,1072,48,1121,1,1123,1,1125,1,1127,1,1129,1,1131,1,1133,1,1135,1,1137,1,1139,1,1141,1,1143,1,1145,1,1147,1,1149,1,1151,1,1153,1,1163,1,1165,1,1167,1,1169,1,1171,1,1173,1,1175,1,1177,1,1179,1,1181,1,1183,1,1185,1,1187,1,1189,1,1191,1,1193,1,1195,1,1197,1,1199,1,1201,1,1203,1,1205,1,1207,1,1209,1,1211,1,1213,1,1215,1,1218,1,1220,1,1222,1,1224,1,1226,1,1228,1,1230,2,1233,1,1235,1,1237,1,1239,1,1241,1,1243,1,1245,1,1247,1,1249,1,1251,1,1253,1,1255,1,1257,1,1259,1,1261,1,1263,1,1265,1,1267,1,1269,1,1271,1,1273,1,1275,1,1277,1,1279,1,1281,1,1283,1,1285,1,1287,1,1289,1,1291,1,1293,1,1295,1,1297,1,1299,1,1301,1,1303,1,1305,1,1307,1,1309,1,1311,1,1313,1,1315,1,1317,1,1319,1,1377,39,7424,44,7522,22,7545,34,7681,1,7683,1,7685,1,7687,1,7689,1,7691,1,7693,1,7695,1,7697,1,7699,1,7701,1,7703,1,7705,1,7707,1,7709,1,7711,1,7713,1,7715,1,7717,1,7719,1,7721,1,7723,1,7725,1,7727,1,7729,1,7731,1,7733,1,7735,1,7737,1,7739,1,7741,1,7743,1,7745,1,7747,1,7749,1,7751,1,7753,1,7755,1,7757,1,7759,1,7761,1,7763,1,7765,1,7767,1,7769,1,7771,1,7773,1,7775,1,7777,1,7779,1,7781,1,7783,1,7785,1,7787,1,7789,1,7791,1,7793,1,7795,1,7797,1,7799,1,7801,1,7803,1,7805,1,7807,1,7809,1,7811,1,7813,1,7815,1,7817,1,7819,1,7821,1,7823,1,7825,1,7827,1,7829,9,7839,1,7841,1,7843,1,7845,1,7847,1,7849,1,7851,1,7853,1,7855,1,7857,1,7859,1,7861,1,7863,1,7865,1,7867,1,7869,1,7871,1,7873,1,7875,1,7877,1,7879,1,7881,1,7883,1,7885,1,7887,1,7889,1,7891,1,7893,1,7895,1,7897,1,7899,1,7901,1,7903,1,7905,1,7907,1,7909,1,7911,1,7913,1,7915,1,7917,1,7919,1,7921,1,7923,1,7925,1,7927,1,7929,1,7931,1,7933,1,7935,9,7952,6,7968,8,7984,8,8000,6,8016,8,8032,8,8048,14,8064,8,8080,8,8096,8,8112,5,8118,2,8126,1,8130,3,8134,2,8144,4,8150,2,8160,8,8178,3,8182,2,8458,1,8462,2,8467,1,8495,1,8500,1,8505,1,8508,2,8518,4,8526,1,8580,1,11312,47,11361,1,11365,2,11368,1,11370,1,11372,1,11377,1,11379,2,11382,7,11393,1,11395,1,11397,1,11399,1,11401,1,11403,1,11405,1,11407,1,11409,1,11411,1,11413,1,11415,1,11417,1,11419,1,11421,1,11423,1,11425,1,11427,1,11429,1,11431,1,11433,1,11435,1,11437,1,11439,1,11441,1,11443,1,11445,1,11447,1,11449,1,11451,1,11453,1,11455,1,11457,1,11459,1,11461,1,11463,1,11465,1,11467,1,11469,1,11471,1,11473,1,11475,1,11477,1,11479,1,11481,1,11483,1,11485,1,11487,1,11489,1,11491,2,11500,1,11502,1,11520,38,42561,1,42563,1,42565,1,42567,1,42569,1,42571,1,42573,1,42575,1,42577,1,42579,1,42581,1,42583,1,42585,1,42587,1,42589,1,42591,1,42593,1,42595,1,42597,1,42599,1,42601,1,42603,1,42605,1,42625,1,42627,1,42629,1,42631,1,42633,1,42635,1,42637,1,42639,1,42641,1,42643,1,42645,1,42647,1,42787,1,42789,1,42791,1,42793,1,42795,1,42797,1,42799,3,42803,1,42805,1,42807,1,42809,1,42811,1,42813,1,42815,1,42817,1,42819,1,42821,1,42823,1,42825,1,42827,1,42829,1,42831,1,42833,1,42835,1,42837,1,42839,1,42841,1,42843,1,42845,1,42847,1,42849,1,42851,1,42853,1,42855,1,42857,1,42859,1,42861,1,42863,1,42865,8,42874,1,42876,1,42879,1,42881,1,42883,1,42885,1,42887,1,42892,1,42894,1,42897,1,42913,1,42915,1,42917,1,42919,1,42921,1,43002,1,64256,7,64275,5,65345,26,66600,40,119834,26,119886,7,119894,18,119938,26,119990,4,119995,1,119997,7,120005,11,120042,26,120094,26,120146,26,120198,26,120250,26,120302,26,120354,26,120406,26,120458,28,120514,25,120540,6,120572,25,120598,6,120630,25,120656,6,120688,25,120714,6,120746,25,120772,6,120779,1];
var h$upperRanges = [65,26,192,23,216,7,256,1,258,1,260,1,262,1,264,1,266,1,268,1,270,1,272,1,274,1,276,1,278,1,280,1,282,1,284,1,286,1,288,1,290,1,292,1,294,1,296,1,298,1,300,1,302,1,304,1,306,1,308,1,310,1,313,1,315,1,317,1,319,1,321,1,323,1,325,1,327,1,330,1,332,1,334,1,336,1,338,1,340,1,342,1,344,1,346,1,348,1,350,1,352,1,354,1,356,1,358,1,360,1,362,1,364,1,366,1,368,1,370,1,372,1,374,1,376,2,379,1,381,1,385,2,388,1,390,2,393,3,398,4,403,2,406,3,412,2,415,2,418,1,420,1,422,2,425,1,428,1,430,2,433,3,437,1,439,2,444,1,452,2,455,2,458,2,461,1,463,1,465,1,467,1,469,1,471,1,473,1,475,1,478,1,480,1,482,1,484,1,486,1,488,1,490,1,492,1,494,1,497,2,500,1,502,3,506,1,508,1,510,1,512,1,514,1,516,1,518,1,520,1,522,1,524,1,526,1,528,1,530,1,532,1,534,1,536,1,538,1,540,1,542,1,544,1,546,1,548,1,550,1,552,1,554,1,556,1,558,1,560,1,562,1,570,2,573,2,577,1,579,4,584,1,586,1,588,1,590,1,880,1,882,1,886,1,902,1,904,3,908,1,910,2,913,17,931,9,975,1,978,3,984,1,986,1,988,1,990,1,992,1,994,1,996,1,998,1,1000,1,1002,1,1004,1,1006,1,1012,1,1015,1,1017,2,1021,51,1120,1,1122,1,1124,1,1126,1,1128,1,1130,1,1132,1,1134,1,1136,1,1138,1,1140,1,1142,1,1144,1,1146,1,1148,1,1150,1,1152,1,1162,1,1164,1,1166,1,1168,1,1170,1,1172,1,1174,1,1176,1,1178,1,1180,1,1182,1,1184,1,1186,1,1188,1,1190,1,1192,1,1194,1,1196,1,1198,1,1200,1,1202,1,1204,1,1206,1,1208,1,1210,1,1212,1,1214,1,1216,2,1219,1,1221,1,1223,1,1225,1,1227,1,1229,1,1232,1,1234,1,1236,1,1238,1,1240,1,1242,1,1244,1,1246,1,1248,1,1250,1,1252,1,1254,1,1256,1,1258,1,1260,1,1262,1,1264,1,1266,1,1268,1,1270,1,1272,1,1274,1,1276,1,1278,1,1280,1,1282,1,1284,1,1286,1,1288,1,1290,1,1292,1,1294,1,1296,1,1298,1,1300,1,1302,1,1304,1,1306,1,1308,1,1310,1,1312,1,1314,1,1316,1,1318,1,1329,38,4256,38,7680,1,7682,1,7684,1,7686,1,7688,1,7690,1,7692,1,7694,1,7696,1,7698,1,7700,1,7702,1,7704,1,7706,1,7708,1,7710,1,7712,1,7714,1,7716,1,7718,1,7720,1,7722,1,7724,1,7726,1,7728,1,7730,1,7732,1,7734,1,7736,1,7738,1,7740,1,7742,1,7744,1,7746,1,7748,1,7750,1,7752,1,7754,1,7756,1,7758,1,7760,1,7762,1,7764,1,7766,1,7768,1,7770,1,7772,1,7774,1,7776,1,7778,1,7780,1,7782,1,7784,1,7786,1,7788,1,7790,1,7792,1,7794,1,7796,1,7798,1,7800,1,7802,1,7804,1,7806,1,7808,1,7810,1,7812,1,7814,1,7816,1,7818,1,7820,1,7822,1,7824,1,7826,1,7828,1,7838,1,7840,1,7842,1,7844,1,7846,1,7848,1,7850,1,7852,1,7854,1,7856,1,7858,1,7860,1,7862,1,7864,1,7866,1,7868,1,7870,1,7872,1,7874,1,7876,1,7878,1,7880,1,7882,1,7884,1,7886,1,7888,1,7890,1,7892,1,7894,1,7896,1,7898,1,7900,1,7902,1,7904,1,7906,1,7908,1,7910,1,7912,1,7914,1,7916,1,7918,1,7920,1,7922,1,7924,1,7926,1,7928,1,7930,1,7932,1,7934,1,7944,8,7960,6,7976,8,7992,8,8008,6,8025,1,8027,1,8029,1,8031,1,8040,8,8072,8,8088,8,8104,8,8120,5,8136,5,8152,4,8168,5,8184,5,8450,1,8455,1,8459,3,8464,3,8469,1,8473,5,8484,1,8486,1,8488,1,8490,4,8496,4,8510,2,8517,1,8579,1,11264,47,11360,1,11362,3,11367,1,11369,1,11371,1,11373,4,11378,1,11381,1,11390,3,11394,1,11396,1,11398,1,11400,1,11402,1,11404,1,11406,1,11408,1,11410,1,11412,1,11414,1,11416,1,11418,1,11420,1,11422,1,11424,1,11426,1,11428,1,11430,1,11432,1,11434,1,11436,1,11438,1,11440,1,11442,1,11444,1,11446,1,11448,1,11450,1,11452,1,11454,1,11456,1,11458,1,11460,1,11462,1,11464,1,11466,1,11468,1,11470,1,11472,1,11474,1,11476,1,11478,1,11480,1,11482,1,11484,1,11486,1,11488,1,11490,1,11499,1,11501,1,42560,1,42562,1,42564,1,42566,1,42568,1,42570,1,42572,1,42574,1,42576,1,42578,1,42580,1,42582,1,42584,1,42586,1,42588,1,42590,1,42592,1,42594,1,42596,1,42598,1,42600,1,42602,1,42604,1,42624,1,42626,1,42628,1,42630,1,42632,1,42634,1,42636,1,42638,1,42640,1,42642,1,42644,1,42646,1,42786,1,42788,1,42790,1,42792,1,42794,1,42796,1,42798,1,42802,1,42804,1,42806,1,42808,1,42810,1,42812,1,42814,1,42816,1,42818,1,42820,1,42822,1,42824,1,42826,1,42828,1,42830,1,42832,1,42834,1,42836,1,42838,1,42840,1,42842,1,42844,1,42846,1,42848,1,42850,1,42852,1,42854,1,42856,1,42858,1,42860,1,42862,1,42873,1,42875,1,42877,2,42880,1,42882,1,42884,1,42886,1,42891,1,42893,1,42896,1,42912,1,42914,1,42916,1,42918,1,42920,1,65313,26,66560,40,119808,26,119860,26,119912,26,119964,1,119966,2,119970,1,119973,2,119977,4,119982,8,120016,26,120068,2,120071,4,120077,8,120086,7,120120,2,120123,4,120128,5,120134,1,120138,7,120172,26,120224,26,120276,26,120328,26,120380,26,120432,26,120488,25,120546,25,120604,25,120662,25,120720,25,120778,1];
var h$alphaRanges = [65,26,97,26,170,1,181,1,186,1,192,23,216,31,248,458,710,12,736,5,748,1,750,1,880,5,886,2,890,4,902,1,904,3,908,1,910,20,931,83,1015,139,1162,158,1329,38,1369,1,1377,39,1488,27,1520,3,1568,43,1646,2,1649,99,1749,1,1765,2,1774,2,1786,3,1791,1,1808,1,1810,30,1869,89,1969,1,1994,33,2036,2,2042,1,2048,22,2074,1,2084,1,2088,1,2112,25,2308,54,2365,1,2384,1,2392,10,2417,7,2425,7,2437,8,2447,2,2451,22,2474,7,2482,1,2486,4,2493,1,2510,1,2524,2,2527,3,2544,2,2565,6,2575,2,2579,22,2602,7,2610,2,2613,2,2616,2,2649,4,2654,1,2674,3,2693,9,2703,3,2707,22,2730,7,2738,2,2741,5,2749,1,2768,1,2784,2,2821,8,2831,2,2835,22,2858,7,2866,2,2869,5,2877,1,2908,2,2911,3,2929,1,2947,1,2949,6,2958,3,2962,4,2969,2,2972,1,2974,2,2979,2,2984,3,2990,12,3024,1,3077,8,3086,3,3090,23,3114,10,3125,5,3133,1,3160,2,3168,2,3205,8,3214,3,3218,23,3242,10,3253,5,3261,1,3294,1,3296,2,3313,2,3333,8,3342,3,3346,41,3389,1,3406,1,3424,2,3450,6,3461,18,3482,24,3507,9,3517,1,3520,7,3585,48,3634,2,3648,7,3713,2,3716,1,3719,2,3722,1,3725,1,3732,4,3737,7,3745,3,3749,1,3751,1,3754,2,3757,4,3762,2,3773,1,3776,5,3782,1,3804,2,3840,1,3904,8,3913,36,3976,5,4096,43,4159,1,4176,6,4186,4,4193,1,4197,2,4206,3,4213,13,4238,1,4256,38,4304,43,4348,1,4352,329,4682,4,4688,7,4696,1,4698,4,4704,41,4746,4,4752,33,4786,4,4792,7,4800,1,4802,4,4808,15,4824,57,4882,4,4888,67,4992,16,5024,85,5121,620,5743,17,5761,26,5792,75,5888,13,5902,4,5920,18,5952,18,5984,13,5998,3,6016,52,6103,1,6108,1,6176,88,6272,41,6314,1,6320,70,6400,29,6480,30,6512,5,6528,44,6593,7,6656,23,6688,53,6823,1,6917,47,6981,7,7043,30,7086,2,7104,38,7168,36,7245,3,7258,36,7401,4,7406,4,7424,192,7680,278,7960,6,7968,38,8008,6,8016,8,8025,1,8027,1,8029,1,8031,31,8064,53,8118,7,8126,1,8130,3,8134,7,8144,4,8150,6,8160,13,8178,3,8182,7,8305,1,8319,1,8336,13,8450,1,8455,1,8458,10,8469,1,8473,5,8484,1,8486,1,8488,1,8490,4,8495,11,8508,4,8517,5,8526,1,8579,2,11264,47,11312,47,11360,133,11499,4,11520,38,11568,54,11631,1,11648,23,11680,7,11688,7,11696,7,11704,7,11712,7,11720,7,11728,7,11736,7,11823,1,12293,2,12337,5,12347,2,12353,86,12445,3,12449,90,12540,4,12549,41,12593,94,12704,27,12784,16,13312,6582,19968,20940,40960,1165,42192,46,42240,269,42512,16,42538,2,42560,47,42623,25,42656,70,42775,9,42786,103,42891,4,42896,2,42912,10,43002,8,43011,3,43015,4,43020,23,43072,52,43138,50,43250,6,43259,1,43274,28,43312,23,43360,29,43396,47,43471,1,43520,41,43584,3,43588,8,43616,23,43642,1,43648,48,43697,1,43701,2,43705,5,43712,1,43714,1,43739,3,43777,6,43785,6,43793,6,43808,7,43816,7,43968,35,44032,11172,55216,23,55243,49,63744,302,64048,62,64112,106,64256,7,64275,5,64285,1,64287,10,64298,13,64312,5,64318,1,64320,2,64323,2,64326,108,64467,363,64848,64,64914,54,65008,12,65136,5,65142,135,65313,26,65345,26,65382,89,65474,6,65482,6,65490,6,65498,3,65536,12,65549,26,65576,19,65596,2,65599,15,65616,14,65664,123,66176,29,66208,49,66304,31,66352,17,66370,8,66432,30,66464,36,66504,8,66560,158,67584,6,67592,1,67594,44,67639,2,67644,1,67647,23,67840,22,67872,26,68096,1,68112,4,68117,3,68121,27,68192,29,68352,54,68416,22,68448,19,68608,73,69635,53,69763,45,73728,879,77824,1071,92160,569,110592,2,119808,85,119894,71,119966,2,119970,1,119973,2,119977,4,119982,12,119995,1,119997,7,120005,65,120071,4,120077,8,120086,7,120094,28,120123,4,120128,5,120134,1,120138,7,120146,340,120488,25,120514,25,120540,31,120572,25,120598,31,120630,25,120656,31,120688,25,120714,31,120746,25,120772,8,131072,42711,173824,4149,177984,222,194560,542];
var h$toUpperMapping = [97,65,98,66,99,67,100,68,101,69,102,70,103,71,104,72,105,73,106,74,107,75,108,76,109,77,110,78,111,79,112,80,113,81,114,82,115,83,116,84,117,85,118,86,119,87,120,88,121,89,122,90,181,924,224,192,225,193,226,194,227,195,228,196,229,197,230,198,231,199,232,200,233,201,234,202,235,203,236,204,237,205,238,206,239,207,240,208,241,209,242,210,243,211,244,212,245,213,246,214,248,216,249,217,250,218,251,219,252,220,253,221,254,222,255,376,257,256,259,258,261,260,263,262,265,264,267,266,269,268,271,270,273,272,275,274,277,276,279,278,281,280,283,282,285,284,287,286,289,288,291,290,293,292,295,294,297,296,299,298,301,300,303,302,305,73,307,306,309,308,311,310,314,313,316,315,318,317,320,319,322,321,324,323,326,325,328,327,331,330,333,332,335,334,337,336,339,338,341,340,343,342,345,344,347,346,349,348,351,350,353,352,355,354,357,356,359,358,361,360,363,362,365,364,367,366,369,368,371,370,373,372,375,374,378,377,380,379,382,381,383,83,384,579,387,386,389,388,392,391,396,395,402,401,405,502,409,408,410,573,414,544,417,416,419,418,421,420,424,423,429,428,432,431,436,435,438,437,441,440,445,444,447,503,453,452,454,452,456,455,457,455,459,458,460,458,462,461,464,463,466,465,468,467,470,469,472,471,474,473,476,475,477,398,479,478,481,480,483,482,485,484,487,486,489,488,491,490,493,492,495,494,498,497,499,497,501,500,505,504,507,506,509,508,511,510,513,512,515,514,517,516,519,518,521,520,523,522,525,524,527,526,529,528,531,530,533,532,535,534,537,536,539,538,541,540,543,542,547,546,549,548,551,550,553,552,555,554,557,556,559,558,561,560,563,562,572,571,575,11390,576,11391,578,577,583,582,585,584,587,586,589,588,591,590,592,11375,593,11373,594,11376,595,385,596,390,598,393,599,394,601,399,603,400,608,403,611,404,613,42893,616,407,617,406,619,11362,623,412,625,11374,626,413,629,415,637,11364,640,422,643,425,648,430,649,580,650,433,651,434,652,581,658,439,837,921,881,880,883,882,887,886,891,1021,892,1022,893,1023,940,902,941,904,942,905,943,906,945,913,946,914,947,915,948,916,949,917,950,918,951,919,952,920,953,921,954,922,955,923,956,924,957,925,958,926,959,927,960,928,961,929,962,931,963,931,964,932,965,933,966,934,967,935,968,936,969,937,970,938,971,939,972,908,973,910,974,911,976,914,977,920,981,934,982,928,983,975,985,984,987,986,989,988,991,990,993,992,995,994,997,996,999,998,1001,1000,1003,1002,1005,1004,1007,1006,1008,922,1009,929,1010,1017,1013,917,1016,1015,1019,1018,1072,1040,1073,1041,1074,1042,1075,1043,1076,1044,1077,1045,1078,1046,1079,1047,1080,1048,1081,1049,1082,1050,1083,1051,1084,1052,1085,1053,1086,1054,1087,1055,1088,1056,1089,1057,1090,1058,1091,1059,1092,1060,1093,1061,1094,1062,1095,1063,1096,1064,1097,1065,1098,1066,1099,1067,1100,1068,1101,1069,1102,1070,1103,1071,1104,1024,1105,1025,1106,1026,1107,1027,1108,1028,1109,1029,1110,1030,1111,1031,1112,1032,1113,1033,1114,1034,1115,1035,1116,1036,1117,1037,1118,1038,1119,1039,1121,1120,1123,1122,1125,1124,1127,1126,1129,1128,1131,1130,1133,1132,1135,1134,1137,1136,1139,1138,1141,1140,1143,1142,1145,1144,1147,1146,1149,1148,1151,1150,1153,1152,1163,1162,1165,1164,1167,1166,1169,1168,1171,1170,1173,1172,1175,1174,1177,1176,1179,1178,1181,1180,1183,1182,1185,1184,1187,1186,1189,1188,1191,1190,1193,1192,1195,1194,1197,1196,1199,1198,1201,1200,1203,1202,1205,1204,1207,1206,1209,1208,1211,1210,1213,1212,1215,1214,1218,1217,1220,1219,1222,1221,1224,1223,1226,1225,1228,1227,1230,1229,1231,1216,1233,1232,1235,1234,1237,1236,1239,1238,1241,1240,1243,1242,1245,1244,1247,1246,1249,1248,1251,1250,1253,1252,1255,1254,1257,1256,1259,1258,1261,1260,1263,1262,1265,1264,1267,1266,1269,1268,1271,1270,1273,1272,1275,1274,1277,1276,1279,1278,1281,1280,1283,1282,1285,1284,1287,1286,1289,1288,1291,1290,1293,1292,1295,1294,1297,1296,1299,1298,1301,1300,1303,1302,1305,1304,1307,1306,1309,1308,1311,1310,1313,1312,1315,1314,1317,1316,1319,1318,1377,1329,1378,1330,1379,1331,1380,1332,1381,1333,1382,1334,1383,1335,1384,1336,1385,1337,1386,1338,1387,1339,1388,1340,1389,1341,1390,1342,1391,1343,1392,1344,1393,1345,1394,1346,1395,1347,1396,1348,1397,1349,1398,1350,1399,1351,1400,1352,1401,1353,1402,1354,1403,1355,1404,1356,1405,1357,1406,1358,1407,1359,1408,1360,1409,1361,1410,1362,1411,1363,1412,1364,1413,1365,1414,1366,7545,42877,7549,11363,7681,7680,7683,7682,7685,7684,7687,7686,7689,7688,7691,7690,7693,7692,7695,7694,7697,7696,7699,7698,7701,7700,7703,7702,7705,7704,7707,7706,7709,7708,7711,7710,7713,7712,7715,7714,7717,7716,7719,7718,7721,7720,7723,7722,7725,7724,7727,7726,7729,7728,7731,7730,7733,7732,7735,7734,7737,7736,7739,7738,7741,7740,7743,7742,7745,7744,7747,7746,7749,7748,7751,7750,7753,7752,7755,7754,7757,7756,7759,7758,7761,7760,7763,7762,7765,7764,7767,7766,7769,7768,7771,7770,7773,7772,7775,7774,7777,7776,7779,7778,7781,7780,7783,7782,7785,7784,7787,7786,7789,7788,7791,7790,7793,7792,7795,7794,7797,7796,7799,7798,7801,7800,7803,7802,7805,7804,7807,7806,7809,7808,7811,7810,7813,7812,7815,7814,7817,7816,7819,7818,7821,7820,7823,7822,7825,7824,7827,7826,7829,7828,7835,7776,7841,7840,7843,7842,7845,7844,7847,7846,7849,7848,7851,7850,7853,7852,7855,7854,7857,7856,7859,7858,7861,7860,7863,7862,7865,7864,7867,7866,7869,7868,7871,7870,7873,7872,7875,7874,7877,7876,7879,7878,7881,7880,7883,7882,7885,7884,7887,7886,7889,7888,7891,7890,7893,7892,7895,7894,7897,7896,7899,7898,7901,7900,7903,7902,7905,7904,7907,7906,7909,7908,7911,7910,7913,7912,7915,7914,7917,7916,7919,7918,7921,7920,7923,7922,7925,7924,7927,7926,7929,7928,7931,7930,7933,7932,7935,7934,7936,7944,7937,7945,7938,7946,7939,7947,7940,7948,7941,7949,7942,7950,7943,7951,7952,7960,7953,7961,7954,7962,7955,7963,7956,7964,7957,7965,7968,7976,7969,7977,7970,7978,7971,7979,7972,7980,7973,7981,7974,7982,7975,7983,7984,7992,7985,7993,7986,7994,7987,7995,7988,7996,7989,7997,7990,7998,7991,7999,8000,8008,8001,8009,8002,8010,8003,8011,8004,8012,8005,8013,8017,8025,8019,8027,8021,8029,8023,8031,8032,8040,8033,8041,8034,8042,8035,8043,8036,8044,8037,8045,8038,8046,8039,8047,8048,8122,8049,8123,8050,8136,8051,8137,8052,8138,8053,8139,8054,8154,8055,8155,8056,8184,8057,8185,8058,8170,8059,8171,8060,8186,8061,8187,8064,8072,8065,8073,8066,8074,8067,8075,8068,8076,8069,8077,8070,8078,8071,8079,8080,8088,8081,8089,8082,8090,8083,8091,8084,8092,8085,8093,8086,8094,8087,8095,8096,8104,8097,8105,8098,8106,8099,8107,8100,8108,8101,8109,8102,8110,8103,8111,8112,8120,8113,8121,8115,8124,8126,921,8131,8140,8144,8152,8145,8153,8160,8168,8161,8169,8165,8172,8179,8188,8526,8498,8560,8544,8561,8545,8562,8546,8563,8547,8564,8548,8565,8549,8566,8550,8567,8551,8568,8552,8569,8553,8570,8554,8571,8555,8572,8556,8573,8557,8574,8558,8575,8559,8580,8579,9424,9398,9425,9399,9426,9400,9427,9401,9428,9402,9429,9403,9430,9404,9431,9405,9432,9406,9433,9407,9434,9408,9435,9409,9436,9410,9437,9411,9438,9412,9439,9413,9440,9414,9441,9415,9442,9416,9443,9417,9444,9418,9445,9419,9446,9420,9447,9421,9448,9422,9449,9423,11312,11264,11313,11265,11314,11266,11315,11267,11316,11268,11317,11269,11318,11270,11319,11271,11320,11272,11321,11273,11322,11274,11323,11275,11324,11276,11325,11277,11326,11278,11327,11279,11328,11280,11329,11281,11330,11282,11331,11283,11332,11284,11333,11285,11334,11286,11335,11287,11336,11288,11337,11289,11338,11290,11339,11291,11340,11292,11341,11293,11342,11294,11343,11295,11344,11296,11345,11297,11346,11298,11347,11299,11348,11300,11349,11301,11350,11302,11351,11303,11352,11304,11353,11305,11354,11306,11355,11307,11356,11308,11357,11309,11358,11310,11361,11360,11365,570,11366,574,11368,11367,11370,11369,11372,11371,11379,11378,11382,11381,11393,11392,11395,11394,11397,11396,11399,11398,11401,11400,11403,11402,11405,11404,11407,11406,11409,11408,11411,11410,11413,11412,11415,11414,11417,11416,11419,11418,11421,11420,11423,11422,11425,11424,11427,11426,11429,11428,11431,11430,11433,11432,11435,11434,11437,11436,11439,11438,11441,11440,11443,11442,11445,11444,11447,11446,11449,11448,11451,11450,11453,11452,11455,11454,11457,11456,11459,11458,11461,11460,11463,11462,11465,11464,11467,11466,11469,11468,11471,11470,11473,11472,11475,11474,11477,11476,11479,11478,11481,11480,11483,11482,11485,11484,11487,11486,11489,11488,11491,11490,11500,11499,11502,11501,11520,4256,11521,4257,11522,4258,11523,4259,11524,4260,11525,4261,11526,4262,11527,4263,11528,4264,11529,4265,11530,4266,11531,4267,11532,4268,11533,4269,11534,4270,11535,4271,11536,4272,11537,4273,11538,4274,11539,4275,11540,4276,11541,4277,11542,4278,11543,4279,11544,4280,11545,4281,11546,4282,11547,4283,11548,4284,11549,4285,11550,4286,11551,4287,11552,4288,11553,4289,11554,4290,11555,4291,11556,4292,11557,4293,42561,42560,42563,42562,42565,42564,42567,42566,42569,42568,42571,42570,42573,42572,42575,42574,42577,42576,42579,42578,42581,42580,42583,42582,42585,42584,42587,42586,42589,42588,42591,42590,42593,42592,42595,42594,42597,42596,42599,42598,42601,42600,42603,42602,42605,42604,42625,42624,42627,42626,42629,42628,42631,42630,42633,42632,42635,42634,42637,42636,42639,42638,42641,42640,42643,42642,42645,42644,42647,42646,42787,42786,42789,42788,42791,42790,42793,42792,42795,42794,42797,42796,42799,42798,42803,42802,42805,42804,42807,42806,42809,42808,42811,42810,42813,42812,42815,42814,42817,42816,42819,42818,42821,42820,42823,42822,42825,42824,42827,42826,42829,42828,42831,42830,42833,42832,42835,42834,42837,42836,42839,42838,42841,42840,42843,42842,42845,42844,42847,42846,42849,42848,42851,42850,42853,42852,42855,42854,42857,42856,42859,42858,42861,42860,42863,42862,42874,42873,42876,42875,42879,42878,42881,42880,42883,42882,42885,42884,42887,42886,42892,42891,42897,42896,42913,42912,42915,42914,42917,42916,42919,42918,42921,42920,65345,65313,65346,65314,65347,65315,65348,65316,65349,65317,65350,65318,65351,65319,65352,65320,65353,65321,65354,65322,65355,65323,65356,65324,65357,65325,65358,65326,65359,65327,65360,65328,65361,65329,65362,65330,65363,65331,65364,65332,65365,65333,65366,65334,65367,65335,65368,65336,65369,65337,65370,65338,66600,66560,66601,66561,66602,66562,66603,66563,66604,66564,66605,66565,66606,66566,66607,66567,66608,66568,66609,66569,66610,66570,66611,66571,66612,66572,66613,66573,66614,66574,66615,66575,66616,66576,66617,66577,66618,66578,66619,66579,66620,66580,66621,66581,66622,66582,66623,66583,66624,66584,66625,66585,66626,66586,66627,66587,66628,66588,66629,66589,66630,66590,66631,66591,66632,66592,66633,66593,66634,66594,66635,66595,66636,66596,66637,66597,66638,66598,66639,66599];
var h$toLowerMapping = [65,97,66,98,67,99,68,100,69,101,70,102,71,103,72,104,73,105,74,106,75,107,76,108,77,109,78,110,79,111,80,112,81,113,82,114,83,115,84,116,85,117,86,118,87,119,88,120,89,121,90,122,192,224,193,225,194,226,195,227,196,228,197,229,198,230,199,231,200,232,201,233,202,234,203,235,204,236,205,237,206,238,207,239,208,240,209,241,210,242,211,243,212,244,213,245,214,246,216,248,217,249,218,250,219,251,220,252,221,253,222,254,256,257,258,259,260,261,262,263,264,265,266,267,268,269,270,271,272,273,274,275,276,277,278,279,280,281,282,283,284,285,286,287,288,289,290,291,292,293,294,295,296,297,298,299,300,301,302,303,304,105,306,307,308,309,310,311,313,314,315,316,317,318,319,320,321,322,323,324,325,326,327,328,330,331,332,333,334,335,336,337,338,339,340,341,342,343,344,345,346,347,348,349,350,351,352,353,354,355,356,357,358,359,360,361,362,363,364,365,366,367,368,369,370,371,372,373,374,375,376,255,377,378,379,380,381,382,385,595,386,387,388,389,390,596,391,392,393,598,394,599,395,396,398,477,399,601,400,603,401,402,403,608,404,611,406,617,407,616,408,409,412,623,413,626,415,629,416,417,418,419,420,421,422,640,423,424,425,643,428,429,430,648,431,432,433,650,434,651,435,436,437,438,439,658,440,441,444,445,452,454,453,454,455,457,456,457,458,460,459,460,461,462,463,464,465,466,467,468,469,470,471,472,473,474,475,476,478,479,480,481,482,483,484,485,486,487,488,489,490,491,492,493,494,495,497,499,498,499,500,501,502,405,503,447,504,505,506,507,508,509,510,511,512,513,514,515,516,517,518,519,520,521,522,523,524,525,526,527,528,529,530,531,532,533,534,535,536,537,538,539,540,541,542,543,544,414,546,547,548,549,550,551,552,553,554,555,556,557,558,559,560,561,562,563,570,11365,571,572,573,410,574,11366,577,578,579,384,580,649,581,652,582,583,584,585,586,587,588,589,590,591,880,881,882,883,886,887,902,940,904,941,905,942,906,943,908,972,910,973,911,974,913,945,914,946,915,947,916,948,917,949,918,950,919,951,920,952,921,953,922,954,923,955,924,956,925,957,926,958,927,959,928,960,929,961,931,963,932,964,933,965,934,966,935,967,936,968,937,969,938,970,939,971,975,983,984,985,986,987,988,989,990,991,992,993,994,995,996,997,998,999,1000,1001,1002,1003,1004,1005,1006,1007,1012,952,1015,1016,1017,1010,1018,1019,1021,891,1022,892,1023,893,1024,1104,1025,1105,1026,1106,1027,1107,1028,1108,1029,1109,1030,1110,1031,1111,1032,1112,1033,1113,1034,1114,1035,1115,1036,1116,1037,1117,1038,1118,1039,1119,1040,1072,1041,1073,1042,1074,1043,1075,1044,1076,1045,1077,1046,1078,1047,1079,1048,1080,1049,1081,1050,1082,1051,1083,1052,1084,1053,1085,1054,1086,1055,1087,1056,1088,1057,1089,1058,1090,1059,1091,1060,1092,1061,1093,1062,1094,1063,1095,1064,1096,1065,1097,1066,1098,1067,1099,1068,1100,1069,1101,1070,1102,1071,1103,1120,1121,1122,1123,1124,1125,1126,1127,1128,1129,1130,1131,1132,1133,1134,1135,1136,1137,1138,1139,1140,1141,1142,1143,1144,1145,1146,1147,1148,1149,1150,1151,1152,1153,1162,1163,1164,1165,1166,1167,1168,1169,1170,1171,1172,1173,1174,1175,1176,1177,1178,1179,1180,1181,1182,1183,1184,1185,1186,1187,1188,1189,1190,1191,1192,1193,1194,1195,1196,1197,1198,1199,1200,1201,1202,1203,1204,1205,1206,1207,1208,1209,1210,1211,1212,1213,1214,1215,1216,1231,1217,1218,1219,1220,1221,1222,1223,1224,1225,1226,1227,1228,1229,1230,1232,1233,1234,1235,1236,1237,1238,1239,1240,1241,1242,1243,1244,1245,1246,1247,1248,1249,1250,1251,1252,1253,1254,1255,1256,1257,1258,1259,1260,1261,1262,1263,1264,1265,1266,1267,1268,1269,1270,1271,1272,1273,1274,1275,1276,1277,1278,1279,1280,1281,1282,1283,1284,1285,1286,1287,1288,1289,1290,1291,1292,1293,1294,1295,1296,1297,1298,1299,1300,1301,1302,1303,1304,1305,1306,1307,1308,1309,1310,1311,1312,1313,1314,1315,1316,1317,1318,1319,1329,1377,1330,1378,1331,1379,1332,1380,1333,1381,1334,1382,1335,1383,1336,1384,1337,1385,1338,1386,1339,1387,1340,1388,1341,1389,1342,1390,1343,1391,1344,1392,1345,1393,1346,1394,1347,1395,1348,1396,1349,1397,1350,1398,1351,1399,1352,1400,1353,1401,1354,1402,1355,1403,1356,1404,1357,1405,1358,1406,1359,1407,1360,1408,1361,1409,1362,1410,1363,1411,1364,1412,1365,1413,1366,1414,4256,11520,4257,11521,4258,11522,4259,11523,4260,11524,4261,11525,4262,11526,4263,11527,4264,11528,4265,11529,4266,11530,4267,11531,4268,11532,4269,11533,4270,11534,4271,11535,4272,11536,4273,11537,4274,11538,4275,11539,4276,11540,4277,11541,4278,11542,4279,11543,4280,11544,4281,11545,4282,11546,4283,11547,4284,11548,4285,11549,4286,11550,4287,11551,4288,11552,4289,11553,4290,11554,4291,11555,4292,11556,4293,11557,7680,7681,7682,7683,7684,7685,7686,7687,7688,7689,7690,7691,7692,7693,7694,7695,7696,7697,7698,7699,7700,7701,7702,7703,7704,7705,7706,7707,7708,7709,7710,7711,7712,7713,7714,7715,7716,7717,7718,7719,7720,7721,7722,7723,7724,7725,7726,7727,7728,7729,7730,7731,7732,7733,7734,7735,7736,7737,7738,7739,7740,7741,7742,7743,7744,7745,7746,7747,7748,7749,7750,7751,7752,7753,7754,7755,7756,7757,7758,7759,7760,7761,7762,7763,7764,7765,7766,7767,7768,7769,7770,7771,7772,7773,7774,7775,7776,7777,7778,7779,7780,7781,7782,7783,7784,7785,7786,7787,7788,7789,7790,7791,7792,7793,7794,7795,7796,7797,7798,7799,7800,7801,7802,7803,7804,7805,7806,7807,7808,7809,7810,7811,7812,7813,7814,7815,7816,7817,7818,7819,7820,7821,7822,7823,7824,7825,7826,7827,7828,7829,7838,223,7840,7841,7842,7843,7844,7845,7846,7847,7848,7849,7850,7851,7852,7853,7854,7855,7856,7857,7858,7859,7860,7861,7862,7863,7864,7865,7866,7867,7868,7869,7870,7871,7872,7873,7874,7875,7876,7877,7878,7879,7880,7881,7882,7883,7884,7885,7886,7887,7888,7889,7890,7891,7892,7893,7894,7895,7896,7897,7898,7899,7900,7901,7902,7903,7904,7905,7906,7907,7908,7909,7910,7911,7912,7913,7914,7915,7916,7917,7918,7919,7920,7921,7922,7923,7924,7925,7926,7927,7928,7929,7930,7931,7932,7933,7934,7935,7944,7936,7945,7937,7946,7938,7947,7939,7948,7940,7949,7941,7950,7942,7951,7943,7960,7952,7961,7953,7962,7954,7963,7955,7964,7956,7965,7957,7976,7968,7977,7969,7978,7970,7979,7971,7980,7972,7981,7973,7982,7974,7983,7975,7992,7984,7993,7985,7994,7986,7995,7987,7996,7988,7997,7989,7998,7990,7999,7991,8008,8000,8009,8001,8010,8002,8011,8003,8012,8004,8013,8005,8025,8017,8027,8019,8029,8021,8031,8023,8040,8032,8041,8033,8042,8034,8043,8035,8044,8036,8045,8037,8046,8038,8047,8039,8072,8064,8073,8065,8074,8066,8075,8067,8076,8068,8077,8069,8078,8070,8079,8071,8088,8080,8089,8081,8090,8082,8091,8083,8092,8084,8093,8085,8094,8086,8095,8087,8104,8096,8105,8097,8106,8098,8107,8099,8108,8100,8109,8101,8110,8102,8111,8103,8120,8112,8121,8113,8122,8048,8123,8049,8124,8115,8136,8050,8137,8051,8138,8052,8139,8053,8140,8131,8152,8144,8153,8145,8154,8054,8155,8055,8168,8160,8169,8161,8170,8058,8171,8059,8172,8165,8184,8056,8185,8057,8186,8060,8187,8061,8188,8179,8486,969,8490,107,8491,229,8498,8526,8544,8560,8545,8561,8546,8562,8547,8563,8548,8564,8549,8565,8550,8566,8551,8567,8552,8568,8553,8569,8554,8570,8555,8571,8556,8572,8557,8573,8558,8574,8559,8575,8579,8580,9398,9424,9399,9425,9400,9426,9401,9427,9402,9428,9403,9429,9404,9430,9405,9431,9406,9432,9407,9433,9408,9434,9409,9435,9410,9436,9411,9437,9412,9438,9413,9439,9414,9440,9415,9441,9416,9442,9417,9443,9418,9444,9419,9445,9420,9446,9421,9447,9422,9448,9423,9449,11264,11312,11265,11313,11266,11314,11267,11315,11268,11316,11269,11317,11270,11318,11271,11319,11272,11320,11273,11321,11274,11322,11275,11323,11276,11324,11277,11325,11278,11326,11279,11327,11280,11328,11281,11329,11282,11330,11283,11331,11284,11332,11285,11333,11286,11334,11287,11335,11288,11336,11289,11337,11290,11338,11291,11339,11292,11340,11293,11341,11294,11342,11295,11343,11296,11344,11297,11345,11298,11346,11299,11347,11300,11348,11301,11349,11302,11350,11303,11351,11304,11352,11305,11353,11306,11354,11307,11355,11308,11356,11309,11357,11310,11358,11360,11361,11362,619,11363,7549,11364,637,11367,11368,11369,11370,11371,11372,11373,593,11374,625,11375,592,11376,594,11378,11379,11381,11382,11390,575,11391,576,11392,11393,11394,11395,11396,11397,11398,11399,11400,11401,11402,11403,11404,11405,11406,11407,11408,11409,11410,11411,11412,11413,11414,11415,11416,11417,11418,11419,11420,11421,11422,11423,11424,11425,11426,11427,11428,11429,11430,11431,11432,11433,11434,11435,11436,11437,11438,11439,11440,11441,11442,11443,11444,11445,11446,11447,11448,11449,11450,11451,11452,11453,11454,11455,11456,11457,11458,11459,11460,11461,11462,11463,11464,11465,11466,11467,11468,11469,11470,11471,11472,11473,11474,11475,11476,11477,11478,11479,11480,11481,11482,11483,11484,11485,11486,11487,11488,11489,11490,11491,11499,11500,11501,11502,42560,42561,42562,42563,42564,42565,42566,42567,42568,42569,42570,42571,42572,42573,42574,42575,42576,42577,42578,42579,42580,42581,42582,42583,42584,42585,42586,42587,42588,42589,42590,42591,42592,42593,42594,42595,42596,42597,42598,42599,42600,42601,42602,42603,42604,42605,42624,42625,42626,42627,42628,42629,42630,42631,42632,42633,42634,42635,42636,42637,42638,42639,42640,42641,42642,42643,42644,42645,42646,42647,42786,42787,42788,42789,42790,42791,42792,42793,42794,42795,42796,42797,42798,42799,42802,42803,42804,42805,42806,42807,42808,42809,42810,42811,42812,42813,42814,42815,42816,42817,42818,42819,42820,42821,42822,42823,42824,42825,42826,42827,42828,42829,42830,42831,42832,42833,42834,42835,42836,42837,42838,42839,42840,42841,42842,42843,42844,42845,42846,42847,42848,42849,42850,42851,42852,42853,42854,42855,42856,42857,42858,42859,42860,42861,42862,42863,42873,42874,42875,42876,42877,7545,42878,42879,42880,42881,42882,42883,42884,42885,42886,42887,42891,42892,42893,613,42896,42897,42912,42913,42914,42915,42916,42917,42918,42919,42920,42921,65313,65345,65314,65346,65315,65347,65316,65348,65317,65349,65318,65350,65319,65351,65320,65352,65321,65353,65322,65354,65323,65355,65324,65356,65325,65357,65326,65358,65327,65359,65328,65360,65329,65361,65330,65362,65331,65363,65332,65364,65333,65365,65334,65366,65335,65367,65336,65368,65337,65369,65338,65370,66560,66600,66561,66601,66562,66602,66563,66603,66564,66604,66565,66605,66566,66606,66567,66607,66568,66608,66569,66609,66570,66610,66571,66611,66572,66612,66573,66613,66574,66614,66575,66615,66576,66616,66577,66617,66578,66618,66579,66619,66580,66620,66581,66621,66582,66622,66583,66623,66584,66624,66585,66625,66586,66626,66587,66627,66588,66628,66589,66629,66590,66630,66591,66631,66592,66632,66593,66633,66594,66634,66595,66635,66596,66636,66597,66637,66598,66638,66599,66639];

// encode a string constant
function h$str(s) {
  var enc = null;
  return function() {
    if(enc === null) {
      enc = h$encodeUtf8(s);
    }
    return enc;
  }
}

// encode a raw string from bytes
function h$rstr(d) {
  var enc = null;
  return function() {
    if(enc === null) {
      enc = h$rawStringData(d);
    }
    return enc;
  }
}

var h$toUpper = null;
function h$u_towupper(ch) {
  if(h$toUpper == null) { h$toUpper = h$decodeMapping(h$toUpperMapping); }
  var r = h$toUpper[ch];
  return (r !== null && r !== undefined) ? r : ch;
}

var h$toLower = null;
function h$u_towlower(ch) {
  if(h$toLower == null) { h$toLower = h$decodeMapping(h$toLowerMapping); }
  var r = h$toLower[ch];
  return (r !== null && r !== undefined) ? r : ch;
}

function h$u_iswspace(ch) {
//  log("### u_iswspace: " + ch);
  return /^\s$/.test(new String(ch)) ? 1 : 0;
}

var h$alpha = null;
function h$u_iswalpha(a) {
  if(h$alpha == null) { h$alpha = h$decodeRle(h$alphaRanges); }
  return h$alpha[a] == 1 ? 1 : 0;

}

var h$alnum = null;
function h$u_iswalnum(a) {
  if(h$alnum == null) { h$alnum = h$decodeRle(h$alnumRanges); }
  return h$alnum[a] == 1 ? 1 : 0;
}

function h$u_iswspace(a) {
    return '\t\n\v\f\r \u0020\u00a0\u1680\u180e\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u202f\u205f\u3000'
        .indexOf(String.fromCharCode(a)) !== -1 ? 1 : 0;
}

var h$lower = null;
function h$u_iswlower(a) {
  if(h$lower == null) { h$lower = h$decodeRle(h$lowerRanges); }
  return h$lower[a] == 1 ? 1 : 0;
}

var h$upper = null;
function h$u_iswupper(a) {
  if(h$upper == null) { h$upper = h$decodeRle(h$upperRanges); }
  return h$upper[a] == 1 ? 1 : 0;
}


var h$cntrl = [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,159];
function h$u_iswcntrl(a) {
  return (h$cntrl.indexOf(a) !== -1) ? 1 : 0;
}

// rle: start,length pairs
var h$print = null;
function h$u_iswprint(a) {
  if(h$print == null) { h$print = h$decodeRle(h$printRanges); }
  return h$print[a] === 1 ? 1 : 0;
}

// decode rle array of start/length pairs
function h$decodeRle(arr) {
  var r = [];
  for(var i=0;i<arr.length;i+=2) {
    var start = arr[i];
    var length = arr[i+1];
    for(var j=start;j<start+length;j++) {
      r[j] = 1;
    }
  }
  return r;
}

// decode a mapping array of from/to pairs
function h$decodeMapping(arr) {
  var r = [];
  for(var i=0;i<arr.length;i+=2) {
    var from = arr[i];
    var to   = arr[i+1];
    r[from] = to;
  }
  return r;
}

function h$localeEncoding() {
    //   log("### localeEncoding");
   h$ret1 = 0; // offset 0
   return h$encodeUtf8("UTF-8");
}

function h$rawStringData(str) {
    var v = h$newByteArray(str.length+1);
    var u8 = v.u8;
    for(var i=0;i<str.length;i++) {
       u8[i] = str[i];
    }
    u8[str.length] = 0;
    return v;
}

// encode a javascript string to a zero terminated utf8 byte array
function h$encodeUtf8(str) {
  var i, low;
  var n = 0;
  for(i=0;i<str.length;i++) {
    // non-BMP encoded as surrogate pair in JavaScript string, get actual codepoint
    var c = str.charCodeAt(i);
    if (0xD800 <= c && c <= 0xDBFF) {
      low = str.charCodeAt(i+1);
      c = ((c - 0xD800) * 0x400) + (low - 0xDC00) + 0x10000;
      i++;
    }
    if(c <= 0x7F) {
      n++;
    } else if(c <= 0x7FF) {
      n+=2;
    } else if(c <= 0xFFFF) {
      n+=3;
    } else if(c <= 0x1FFFFF) {
      n+=4;
    } else if(c <= 0x3FFFFFF) {
      n+=5;
    } else {
      n+=6;
    }
  }
  var v = h$newByteArray(n+1);
  var u8 = v.u8;
  n = 0;
  for(i=0;i<str.length;i++) {
    var c = str.charCodeAt(i);
    // non-BMP encoded as surrogate pair in JavaScript string, get actual codepoint
    if (0xD800 <= c && c <= 0xDBFF) {
      low = str.charCodeAt(i+1);
      c = ((c - 0xD800) * 0x400) + (low - 0xDC00) + 0x10000;
      i++;
    }
//    log("### encoding char " + c + " to UTF-8: " + String.fromCodePoint(c));
    if(c <= 0x7F) {
      u8[n] = c;
      n++;
    } else if(c <= 0x7FF) {
      u8[n] = (c >> 6) | 0xC0;
      u8[n+1] = (c & 0x3F) | 0x80;
      n+=2;
    } else if(c <= 0xFFFF) {
      u8[n]   = (c >> 12) | 0xE0;
      u8[n+1] = ((c >> 6) & 0x3F) | 0x80;
      u8[n+2] = (c & 0x3F) | 0x80;
      n+=3;
    } else if(c <= 0x1FFFFF) {
      u8[n]   = (c >> 18) | 0xF0;
      u8[n+1] = ((c >> 12) & 0x3F) | 0x80;
      u8[n+2] = ((c >> 6) & 0x3F) | 0x80;
      u8[n+3] = (c & 0x3F) | 0x80;
      n+=4;
    } else if(c <= 0x3FFFFFF) {
      u8[n]   = (c >> 24) | 0xF8;
      u8[n+1] = ((c >> 18) & 0x3F) | 0x80;
      u8[n+2] = ((c >> 12) & 0x3F) | 0x80;
      u8[n+3] = ((c >> 6) & 0x3F) | 0x80;
      u8[n+4] = (c & 0x3F) | 0x80;
      n+=5;
    } else {
      u8[n]   = (c >>> 30) | 0xFC;
      u8[n+1] = ((c >> 24) & 0x3F) | 0x80;
      u8[n+2] = ((c >> 18) & 0x3F) | 0x80;
      u8[n+3] = ((c >> 12) & 0x3F) | 0x80;
      u8[n+4] = ((c >> 6) & 0x3F) | 0x80;
      u8[n+5] = (c & 0x3F) | 0x80;
      n+=6;
    }
  }
  u8[v.len-1] = 0; // terminator
//  log("### encodeUtf8: " + str);
//  log(v);
  return v;
}

// encode a javascript string to a zero terminated utf16 byte array
function h$encodeUtf16(str) {
  var n = 0;
  var i;
  for(i=0;i<str.length;i++) {
    var c = str.charCodeAt(i);
    if(c <= 0xFFFF) {
      n += 2;
    } else {
      n += 4;
    }
  }
  var v = h$newByteArray(n+1);
  var dv = v.dv;
  n = 0;
  for(i=0;i<str.length;i++) {
    var c = str.charCodeAt(i);
    if(c <= 0xFFFF) {
      dv.setUint16(n, c, true);
      n+=2;
    } else {
      var c0 = c - 0x10000;
      dv.setUint16(n,   c0 >> 10, true);
      dv.setUint16(n+2, c0 & 0x3FF, true);
      n+=4;
    }
  }
  dv.setUint8(v.len-1,0);  // terminator
  return v;
}

// convert a string to a buffer, set second field in
// Addr# to length
function h$fromStr(s) {
  var l = s.length;
  var b = h$newByteArray(l * 2);
  var dv = b.dv;
  for(var i=l-1;i>=0;i--) {
    dv.setUint16(i<<1, s.charCodeAt(i), true);
  }
  h$ret1 = l;
  return b;
}

// convert a Data.Text buffer with offset/length to a
// JS string
function h$toStr(b,o,l) {
  var a = [];
  var end = 2*(o+l);
  var k = 0;
  var dv = b.dv;
  for(var i=2*o;i<end;i+=2) {
    var cc = dv.getUint16(i,true);
    a[k++] = cc;
  }
  return String.fromCharCode.apply(this, a);
}

/*
function h$encodeUtf16(str) {
  var b = new DataView(new ArrayBuffer(str.length * 2));
  for(var i=str.length-1;i>=0;i--) {
    b.setUint16(i<<1, str.charCodeAt(i));
  }
  h$ret1 = 0;
  return b;
}
var h$eU16 = h$encodeUtf16;

function h$decodeUtf16(v,start) {
  return h$decodeUtf16(v, v.byteLength - start, start);
}

function h$decodeUtf16z(v,start) {
  var len = v.byteLength - start;
  for(var i=start;i<l;i+=2) {
    if(v.getUint16(i) === 0) {
      len = i;
      break;
    }
  }
  return h$decodeUtf16l(v,l,start)
}
*/

function h$decodeUtf16l(v, byteLen, start) {
  // perhaps we can apply it with an Uint16Array view, but that might give us endianness problems
  var a = [];
  for(var i=0;i<byteLen;i+=2) {
    a[i>>1] = v.dv.getUint16(i+start,true);
  }
  return String.fromCharCode.apply(this, a);
}
var h$dU16 = h$decodeUtf16;

// decode a buffer with UTF-8 chars to a JS string
// stop at the first zero
function h$decodeUtf8z(v,start) {
//  log("h$decodeUtf8z");
  var n = start;
  var max = v.len;
  while(n < max) {
//    log("### " + n + " got char: " + v.u8[n]);
    if(v.u8[n] === 0) { break; }
    n++;
  }
  return h$decodeUtf8(v,n,start);
}

// decode a buffer with Utf8 chars to a JS string
// invalid characters are ignored
function h$decodeUtf8(v,n0,start) {
//  log("### decodeUtf8");
//  log(v);
  var n = n0 || v.len;
  var arr = [];
  var i = start || 0;
  var code;
  var u8 = v.u8;
//  log("### decoding, starting at:  " + i);
  while(i < n) {
    var c = u8[i];
    while((c & 0xC0) === 0x80) {
      c = u8[++i];
    }
//    log("### lead char: " + c);
    if((c & 0x80) === 0) {
      code = (c & 0x7F);
      i++;
    } else if((c & 0xE0) === 0xC0) {
      code = ( ((c & 0x1F) << 6)
             | (u8[i+1] & 0x3F)
             );
      i+=2;
    } else if((c & 0xF0) === 0xE0) {
      code = ( ((c & 0x0F) << 12)
             | ((u8[i+1] & 0x3F) << 6)
             | (u8[i+2] & 0x3F)
             );
      i+=3;
    } else if ((c & 0xF8) === 0xF0) {
      code = ( ((c & 0x07) << 18)
             | ((u8[i+1] & 0x3F) << 12)
             | ((u8[i+2] & 0x3F) <<  6)
             | (u8[i+3] & 0x3F)
             );
      i+=4;
    } else if((c & 0xFC) === 0xF8) {
      code = ( ((c & 0x03) << 24)
             | ((u8[i+1] & 0x3F) << 18)
             | ((u8[i+2] & 0x3F) << 12)
             | ((u8[i+3] & 0x3F) <<  6)
             | (u8[i+4] & 0x3F)
             );
      i+=5;
    } else {
      code = ( ((c & 0x01) << 30)
             | ((u8[i+1] & 0x3F) << 24)
             | ((u8[i+2] & 0x3F) << 18)
             | ((u8[i+3] & 0x3F) << 12)
             | ((u8[i+4] & 0x3F) <<  6)
             | (u8[i+5] & 0x3F)
             );
      i+=6;
    }
    // log("### decoded codePoint: " + code + " - " + String.fromCharCode(code)); // String.fromCodePoint(code));
    // need to deal with surrogate pairs
    if(code > 0xFFFF) {
      var offset = code - 0x10000;
      arr.push(0xD800 + (offset >> 10), 0xDC00 + (offset & 0x3FF));
    } else {
      arr.push(code);
    }
  }
  return String.fromCharCode.apply(this, arr);
}

// fixme what if terminator, then we read past end
function h$decodeUtf16(v) {
  var n = v.len;
  var arr = [];
  var dv = v.dv;
  for(var i=0;i<n;i+=2) {
    arr.push(dv.getUint16(i,true));
  }
  return String.fromCharCode.apply(this, arr);
}

// var charsets = ["UTF-8"] -> UTF-32LE 


function h$hs_iconv_open(to,to_off,from,from_off) {
  h$errno = h$EINVAL; // no encodings supported
  return -1;
//  var fromStr = decodeUtf8(from, from_off);
//  var toStr = decodeUtf8(to, to_off);
//  log("#### hs_iconv_open: " + fromStr + " -> " + toStr);
//  return 1; // fixme?
}

function h$hs_iconv_close(iconv) {
  return 0;
}

function h$hs_iconv(iconv, inbuf,  inbuf_off, insize, insize_off,
                           outbuf, outbuf_off, outsize, outsize_off) {
//  var inbuf2      = derefPtrA(inbuf, inbuf_off);
//  var inbuf2_off  = derefPtrO(inbuf, inbuf_off);
//  var outbuf2     = derefPtrA(outbuf, outbuf_off);
//  var outbuf2_off = derefPtrO(outbuf, outbuf_off);
//  var insiz       = insize.getUint32(insize_off);
//  var outsiz      = outsize.getUint32(outsize_off);
  // fixme support other encodings
//  log("### hs_iconv");
  return utf32leToUtf8(inbuf, inbuf_off, insize, insize_off,
                       outbuf, outbuf_off, outsize, outsize_off);
}

// ptr* -> ptr (array)
function h$derefPtrA(ptr, ptr_off) {
  return ptr.arr[ptr_off][0];
}
// ptr* -> ptr (offset)
function h$derefPtrO(ptr, ptr_off) {
  return ptr.arr[ptr_off][1];
}

// word** -> word    ptr[x][y]
function h$readPtrPtrU32(ptr, ptr_off, x, y) {
  x = x || 0;
  y = y || 0;
  var arr = ptr.arr[ptr_off + 4 * x];
  return arr[0].dv.getInt32(arr[1] + 4 * y, true);
}

// char** -> char   ptr[x][y]
function h$readPtrPtrU8(ptr, ptr_off, x, y) {
  x = x || 0;
  y = y || 0;
  var arr = ptr.arr[ptr_off + 4 * x];
  return arr[0].dv.getUint8(arr[1] + y);
}

// word**   ptr[x][y] = v
function h$writePtrPtrU32(ptr, ptr_off, v, x, y) {
  x = x || 0;
  y = y || 0;
  var arr = ptr.arr[ptr_off + 4 * x];
  arr[0].dv.putInt32(arr[1] + y, v);
}

// unsigned char** ptr[x][y] = v
function h$writePtrPtrU8(ptr, ptr_off, v, x, y) {
  x = x || 0;
  y = y || 0;
  var arr = ptr.arr[ptr_off+ 4 * x];
  arr[0].dv.putUint8(arr[1] + y, v);
}

// convert JavaScript String to a Haskell String
function h$toHsString(str) {
  var i = str.length - 1;
  var r = h$ghczmprimZCGHCziTypesziZMZN;
  while(i>=0) {
    var cp = str.charCodeAt(i);
    if((0xDC00 & cp) && i > 0) {
      --i;
      cp = (cp - 0xDC00) + (str.charCodeAt(i) & 0xD800) * 1024;
    }
    r = h$c2(h$ghczmprimZCGHCziTypesziZC_con_e, cp, r);
    --i;
  }
  return r;
}

// throw e wrapped in a GHCJS.Prim.JSException  in the current thread
function h$throwJSException(e) {
  // a GHCJS.Prim.JSException
  var jsE = h$c2(h$ghcjszmprimZCGHCJSziPrimziJSException_con_e,e,h$toHsString(e.toString()));
  // wrap it in a SomeException, adding the Exception dictionary
  var someE = h$c2(h$baseZCGHCziExceptionziSomeException_con_e,
     h$ghcjszmprimZCGHCJSziPrimzizdfExceptionJSException, jsE);
  return h$throw(someE, true);
}

// function encodeSame(inbuf, inbuf_off, insize, insize_off

/* specialized implementations of utf8 <-> utf32, utf8 <-> utf16
 * since utf8 is the most used interchange format and utf32
 * is used by haskell internally, utf16 for the Text package
 */
/* outdated, need to update to little endian if used again
function h$utf32leToUtf8(inbuf0, inbuf_off0, insize, insize_off,
                       outbuf0, outbuf_off0, outsize, outsize_off) {

  var inbuf      = h$derefPtrA(inbuf0, inbuf_off0);
  var inbuf_off  = h$derefPtrO(inbuf0, inbuf_off0);
  var outbuf     = h$derefPtrA(outbuf0, outbuf_off0);
  var outbuf_off = h$derefPtrO(outbuf0, outbuf_off0);

  var inbuf_left = insize.getUint32(insize_off);
  var outbuf_left = outsize.getUint32(outsize_off);
  var in_max  = inbuf_off + inbuf_left;
  var out_max = outbuf_off + outbuf_left;
  var in_off    = inbuf_off;
  var out_off   = outbuf_off;
  var n = 0;
  var partial = false;
//  log("### converting utf8");
//  log("### inbuf_off: " + inbuf_off);
//  log("### inbuf_left: " + inbuf_left);
//  log("### in_max: " + in_max);
//  log("### nbuf length: " + inbuf.byteLength);
  while(in_off + 3 < in_max) {
//    log("### converting: " + in_off);
    var codePoint = inbuf.getUint32(in_off);
//    log("### converting " + codePoint + " to UTF-8: " + String.fromCodePoint(codePoint));
    if(codePoint <= 0x7F) {
      if(out_off + 1 < out_max) {
        outbuf.setUint8(out_off, codePoint);
        out_off++;
      } else {
        partial = true;
        break;
      }
    } else if(codePoint <= 0x7FF) {
      if(out_off + 2 < out_max) {
        outbuf.setUint8(out_off, (codePoint >> 6) | 0xC0);
        outbuf.setUint8(out_off+1, (codePoint & 0x3F) | 0x80);
        out_off += 2;
      } else {
        partial = true;
        break;
      }
    } else if(codePoint <= 0xFFFF) {
      if(out_off + 3 < out_max) {
        outbuf.setUint8(out_off, (codePoint >> 12) | 0xE0);
        outbuf.setUint8(out_off+1, ((codePoint >> 6) & 0x3F) | 0x80);
        outbuf.setUint8(out_off+2, (codePoint & 0x3F) | 0x80);
//        log("### encoded triple: " + outbuf.getUint8(out_off) + ", " + outbuf.getUint8(out_off+1) + ", " + outbuf.getUint8(out_off+2));
        out_off += 3;
      } else {
        partial = true;
        break;
      }
    } else if(codePoint <= 0x1FFFFF) {
      if(out_off + 4 < out_max) {
        outbuf.setUint8(out_off, (codePoint >> 18) | 0xF0);
        outbuf.setUint8(out_off+1, ((codePoint >> 12) & 0x3F) | 0x80);
        outbuf.setUint8(out_off+2, ((codePoint >> 6) & 0x3F) | 0x80);
        outbuf.setUint8(out_off+3, (codePoint & 0x3F) | 0x80);
        out_off += 4;
      } else {
        partial = true;
        break;
      }
    } else if(codePoint <= 0x3FFFFFF) {
      if(out_off + 5 < out_max) {
        outbuf.setUint8(out_off, (codePoint >> 24) | 0xF8);
        outbuf.setUint8(out_off+1, ((codePoint >> 18) & 0x3F) | 0x80);
        outbuf.setUint8(out_off+2, ((codePoint >> 12) & 0x3F) | 0x80);
        outbuf.setUint8(out_off+3, ((codePoint >> 6) & 0x3F) | 0x80);
        outbuf.setUint8(out_off+4, (codePoint & 0x3F) | 0x80);
        out_off += 5;
      } else {
        partial = true;
        break;
      }
    } else {
      if(out_off + 6 < out_max) {
        outbuf.setUint8(out_off, (codePoint >>> 30) | 0xFC);
        outbuf.setUint8(out_off+1, ((codePoint >> 24) & 0x3F) | 0x80);
        outbuf.setUint8(out_off+2, ((codePoint >> 18) & 0x3F) | 0x80);
        outbuf.setUint8(out_off+3, ((codePoint >> 12) & 0x3F) | 0x80);
        outbuf.setUint8(out_off+4, ((codePoint >> 6) & 0x3F) | 0x80);
        outbuf.setUint8(out_off+5, (codePoint & 0x3F) | 0x80);
        out_off += 6;
      } else {
        partial = true;
        break;
      }
    }
    in_off += 4;
  }
  outsize.setUint32(outsize_off, out_max - out_off);
  insize.setUint32(insize_off, in_max - in_off);
//  log("### converted chars: " + ((in_off - inbuf_off) / 4));
//  return 0; // all conversions are reversible return (in_off - inbuf_off) / 4;
  if(partial) {
    inbuf0.arr[inbuf_off0][1] = in_off;
    h$errno = h$E2BIG;
    return -1;
  } else {
    return 0;
  }
}
*/



/* 
   Integer and integer-gmp support
   partial GMP emulation

   note: sign behaves different from real gmp sign,
         value is always zero, don't use it for comparisons
*/

var h$logInt = function() { log.apply(log,arguments); }
// var h$logInt = function() { }
BigInteger.prototype.am = am3;
dbits = 28;
DV = (1<<dbits);
BigInteger.prototype.DB = dbits;
BigInteger.prototype.DM = ((1<<dbits)-1);
BigInteger.prototype.DV = (1<<dbits);
var BI_FP = 52;
BigInteger.prototype.FV = Math.pow(2,BI_FP);
BigInteger.prototype.F1 = BI_FP-dbits;
BigInteger.prototype.F2 = 2*dbits-BI_FP;

h$bigZero = nbv(0);
h$bigOne = nbv(1); // new BigInteger([1]);
h$bigCache = [];
for(var i=0;i<=100;i++) {
  h$bigCache.push(nbv(i));
}
// convert a value to a BigInt
function h$bigFromInt(v) {
//  h$logInt("### h$bigFromInt: " + v);
  var v0 = v|0;
  if(v0 >= 0) {
    if(v0 <= 100) {
      return h$bigCache[v0];
    } else if(v0 < 268435456) { // 67108864) { // guaranteed to fit in one digit
      return nbv(v0);
    }
    var r1 = nbv(v0 >>> 16);
    var r2 = nbi();
    r1.lShiftTo(16,r2);
    r1.fromInt(v0 & 0xffff);
    var r3 = r1.or(r2);
//    h$logInt("### result: " + r3.toString());
    return r3;
  } else {
    v0 = -v0;
    if(v0 < 268435456) { // 67108864) {
      return nbv(v0).negate();
    }
    var r1 = nbv(v0 >>> 16);
    var r2 = nbi();
    r1.lShiftTo(16,r2);
    r1.fromInt(v0 & 0xffff);
    var r3 = r1.or(r2);
    BigInteger.ZERO.subTo(r3,r2);
//    h$logInt("### result: " + r2.toString());
    return r2;
  }
}

function h$bigFromWord(v) {
  var v0 = v|0;
  if(v0 >= 0) {
    if(v0 <= 100) {
      return h$bigCache[v0];
    } else if(v0 < 268435456) { // 67108864) { // guaranteed to fit in one digit
      return nbv(v0);
    }
  }
  var r1 = nbv(v0 >>> 16);
  var r2 = nbv(0);
  r1.lShiftTo(16,r2);
  r1.fromInt(v0 & 0xffff);
  return r1.or(r2);
}

function h$bigFromInt64(v1,v2) {
//  h$logInt("### h$bigFromInt64: " + v1 + " " + v2);
  var v10 = v1|0;
  var v20 = v2|0;
  var r = new BigInteger([ v10 >>  24, (v10 & 0xff0000) >> 16, (v10 & 0xff00) >> 8, v10 & 0xff
                         , v20 >>> 24, (v20 & 0xff0000) >> 16, (v20 & 0xff00) >> 8, v20 & 0xff
                         ]);
//  h$logInt("### result: " + r.toString());
  return r;
}

function h$bigFromWord64(v1,v2) {
//  h$logInt("### h$bigFromWord64: " + v1 + " " + v2);
  var v10 = v1|0;
  var v20 = v2|0;
  var arr = [ 0, v10 >>> 24, (v10 & 0xff0000) >> 16, (v10 & 0xff00) >> 8, v10 & 0xff
                         , v20 >>> 24, (v20 & 0xff0000) >> 16, (v20 & 0xff00) >> 8, v20 & 0xff
                         ];
//  h$logInt(arr);
  var r = new BigInteger([ 0, v10 >>> 24, (v10 & 0xff0000) >> 16, (v10 & 0xff00) >> 8, v10 & 0xff
                         , v20 >>> 24, (v20 & 0xff0000) >> 16, (v20 & 0xff00) >> 8, v20 & 0xff
                         ]);
//  h$logInt("### result: " + r.toString());
  return r;
}

function h$bigFromNumber(n) {
  var ra = [];
  var s = 0;
  if(n < 0) {
    n = -n;
    s = -1;
  }
  var b = 1;
  while(n >= b) {
    ra.unshift((n/b)&0xff);
    b *= 256;
  }
  ra.unshift(s);
  return new BigInteger(ra);
}

function h$encodeNumber(big,e) {
  var m = Math.pow(2,e);
  if(m === Infinity) {
    switch(big.signum()) {
      case 1: return Infinity;
      case 0: return 0;
      default: return -Infinity;
    }
  }
  var b = big.toByteArray();
  var l = b.length;
  var r = 0;
//  h$logInt(b);
  for(var i=l-1;i>=1;i--) {
//    h$logInt("### i: " + i + " b[i] " + b[i]);
    r += m * Math.pow(2,(l-i-1)*8) * (b[i] & 0xff);
//    h$logInt(r);
  }
  // last one signed
  if(b[0] != 0) {
    r += m * Math.pow(2,(l-1)*8) * b[0];
  }
//  h$logInt(r);
//  h$logInt("### result: " + r);
  return r;
}

function h$integer_cmm_cmpIntegerzh(sa, abits, sb, bbits) {
  var c = abits.compareTo(bbits);
  return c == 0 ? 0 : c > 0 ? 1 : -1;
}

function h$integer_cmm_cmpIntegerIntzh(sa, abits, b) {
  var res = abits.compareTo(h$bigFromInt(b));
  return res;
}

function h$integer_cmm_plusIntegerzh(sa, abits, sb, bbits) {
    h$ret1 = abits.add(bbits);
    return 0;
}

function h$integer_cmm_minusIntegerzh(sa, abits, sb, bbits) {
    h$ret1 = abits.subtract(bbits);
    return 0;
}

function h$integer_cmm_timesIntegerzh(sa, abits, sb, bbits) {
    h$ret1 = abits.multiply(bbits);
    return 0;
}

// fixme make more efficient, divideRemainder
function h$integer_cmm_quotRemIntegerzh(sa, abits, sb, bbits) {
    var q = abits.divide(bbits);
//    h$logInt("### q: " + q.toString());
    var r = abits.subtract(q.multiply(bbits));
//    h$logInt("### r: " + r.toString());
    h$ret1 = q;
    h$ret2 = 0;
    h$ret3 = r;
    return 0;
}

function h$integer_cmm_quotIntegerzh(sa, abits, sb, bbits) {
    h$ret1 = abits.divide(bbits);
    return 0;
}

function h$integer_cmm_remIntegerzh(sa, abits, sb, bbits) {
    h$ret1 = abits.subtract(bbits.multiply(abits.divide(bbits)));
//    h$logInt("### result: " + ret1.toString());
    return 0;
}

function h$integer_cmm_divModIntegerzh(sa, abits, sb, bbits) {
    var d = abits.divide(bbits);
    var m = abits.subtract(d.multiply(bbits));
    if(abits.signum()!==bbits.signum() && m.signum() !== 0) {
        d = d.subtract(h$bigOne);
        m = m.add(bbits);
    }
    h$ret1 = d;
    h$ret2 = 0;
    h$ret3 = m;
    return 0;
}

function h$integer_cmm_divIntegerzh(sa, abits, sb, bbits) {
    var d = abits.divide(bbits);
    var m = abits.subtract(d.multiply(bbits));
    if(abits.signum()!==bbits.signum() && m.signum() !== 0) {
        d = d.subtract(h$bigOne);
    }
    h$ret1 = d;
    return 0;
}

function h$integer_cmm_modIntegerzh(sa, abits, sb, bbits) {
    var d = abits.divide(bbits);
    var m = abits.subtract(d.multiply(bbits));
    if(abits.signum()!==bbits.signum() && m.signum() !== 0) {
        m = m.add(bbits);
    }
    h$ret1 = m;
    return 0;
}
function h$integer_cmm_divExactIntegerzh(sa, abits, sb, bbits) {
    h$ret1 = abits.divide(bbits);
    return 0;
}

function h$gcd(a, b) {
    var x = a.abs();
    var y = b.abs();
    var big, small;
    if(x.compareTo(y) < 0) {
        small = x;
        big = y;
    } else {
        small = y;
        big = x;
    }
    while(small.signum() !== 0) {
        var q = big.divide(small);
        var r = big.subtract(q.multiply(small));
        big = small;
        small = r;
    }
    return big;
}

function h$integer_cmm_gcdIntegerzh(sa, abits, sb, bbits) {
    h$ret1 = h$gcd(abits, bbits);
    return 0;
}

function h$integer_cmm_gcdIntegerIntzh(sa, abits, b) {
    var r = h$gcd(abits, h$bigFromInt(b));
    return r.intValue();
}

function h$integer_cmm_gcdIntzh(a, b) {
        var x = a<0 ? -a : a;
        var y = b<0 ? -b : b;
        var big, small;
        if(x<y) {
            small = x;
            big = y;
        } else {
            small = y;
            big = x;
        }
        while(small!==0) {
            var r = big % small;
            big = small;
            small = r;
        }
        return big;
}

var h$oneOverLog2 = 1 / Math.log(2);

function h$integer_cmm_decodeDoublezh(x) {
    if(isNaN(x)) {
      h$ret2 = h$bigFromInt(3).shiftLeft(51).negate();
      h$ret1 = 0;
      return 972;
    }
    if( x < 0 ) {
        var result = h$integer_cmm_decodeDoublezh(-x);
        h$ret2 = h$ret2.negate();
        h$ret1 = h$ret2.signum();
        return result;
    }
    if(x === Number.POSITIVE_INFINITY) {
        h$ret2 = h$bigOne.shiftLeft(52);
        h$ret1 = 0;
        return 972;
    }
    var exponent = Math.floor(Math.log(x) * h$oneOverLog2)-52;
    var n;
    // prevent overflow
    if(exponent < -1000) {
      n = x * Math.pow(2,-exponent-128) * Math.pow(2,128);
    } else if(exponent > 900) {
      n = x * Math.pow(2,-exponent+128) * Math.pow(2,-128);
    } else {
      n = x * Math.pow(2,-exponent);
    }
    // fixup precision, do we also need the other way (exponent++) ?
    if(Math.abs(n - Math.floor(n) - 0.5) < 0.0001) {
      exponent--;
      n *= 2;
    }
    h$ret2 = h$bigFromNumber(n);
    h$ret1 = 0;
    return exponent;
}

function h$integer_cmm_int2Integerzh(i) {
    h$ret1 = h$bigFromInt(i);
    return 0;
}

function h$integer_cmm_word2Integerzh(i) {
    h$ret1 = h$bigFromWord(i);
    return 0;
}

function h$integer_cmm_andIntegerzh(sa, abits, sb, bbits) {
    h$ret1 = abits.and(bbits);
    return 0;
}

function h$integer_cmm_orIntegerzh(sa, abits, sb, bbits) {
    h$ret1 = abits.or(bbits);
    return 0;
}

function h$integer_cmm_xorIntegerzh(sa, abits, sb, bbits) {
    h$ret1 = abits.xor(bbits);
    return 0;
}

function h$integer_cmm_testBitIntegerzh(sa, abits, bit) {
    return abits.testBit(bit)?1:0;
}

function h$integer_cmm_mul2ExpIntegerzh(sa, abits, b) {
    h$ret1 = abits.shiftLeft(b);
    return 0;
}

function h$integer_cmm_fdivQ2ExpIntegerzh(sa, abits, b) {
    h$ret1 = abits.shiftRight(b);
    return 0;
}

function h$integer_cmm_complementIntegerzh(sa, abits) {
    h$ret1 = abits.not();
    return 0;
}

function h$integer_cmm_int64ToIntegerzh(a0, a1) {
    h$ret1 = h$bigFromInt64(a0,a1);
    return 0;
}

function h$integer_cmm_word64ToIntegerzh(a0, a1) {
    h$ret1 = h$bigFromWord64(a0,a1);
    return 0;
}

function h$hs_integerToInt64(as, abits) {
    h$ret1 = abits.intValue();
    return abits.shiftRight(32).intValue();
}

function h$hs_integerToWord64(as, abits) {
    h$ret1 = abits.intValue();
    return abits.shiftRight(32).intValue();
}

function h$integer_cmm_integer2Intzh(as, abits) {
   return abits.intValue();
}

function h$integer_cbits_encodeDouble(as,abits,e) {
   return h$encodeNumber(abits,e);
}

function h$integer_cbits_encodeFloat(as,abits,e) {
   return h$encodeNumber(abits,e);
}

function h$__int_encodeDouble(i,e) {
   return i * Math.pow(2,e);
}

function h$__int_encodeFloat(i,e) {
   return i * Math.pow(2,e);
}



var h$programArgs;
if(typeof scriptArgs !== 'undefined') {
  h$programArgs = scriptArgs.slice(0);
  h$programArgs.unshift("a.js");
} else if(typeof process !== 'undefined' && process.argv) {
  h$programArgs = process.argv.slice(1);
} else if(typeof arguments !== 'undefined') {
  h$programArgs = arguments.slice(0);
  h$programArgs.unshift("a.js");
} else {
  h$programArgs = [ "a.js" ];
}

function h$getProgArgv(argc_v,argc_off,argv_v,argv_off) {
  var c = h$programArgs.length;
  if(c === 0) {
    argc_v.dv.setInt32(argc_off, 0, true);
  } else {
    argc_v.dv.setInt32(argc_off, c, true);
    var argv = h$newByteArray(4*c);
    argv.arr = [];
    for(var i=0;i<h$programArgs.length;i++) {
      argv.arr[4*i] = [ h$encodeUtf8(h$programArgs[i]), 0 ];
    }
    if(!argv_v.arr) { argv_v.arr = []; }
    argv_v.arr[argv_off] = [argv, 0];
  }
}

function h$__hscore_environ() {
  h$ret1 = 0;
  return null;
}

function h$getenv() {
  h$ret1 = 0;
  return null;
}

function h$errorBelch() {
  log("### errorBelch: do we need to handle a vararg function here?");
}

function h$errorBelch2(buf1, buf_offset1, buf2, buf_offset2) {
//  log("### errorBelch2");
  h$errorMsg(h$decodeUtf8z(buf1, buf_offset1), h$decodeUtf8z(buf2, buf_offset2));
}

function h$debugBelch2(buf1, buf_offset1, buf2, buf_offset2) {
  h$errorMsg(h$decodeUtf8z(buf1, buf_offset1), h$decodeUtf8z(buf2, buf_offset2));
}

function h$errorMsg(pat) {
  // poor man's vprintf
  var str = pat;
  for(var i=1;i<arguments.length;i++) {
    str = str.replace(/%s/, arguments[i]);
  }
  if(typeof process !== 'undefined' && process && process.stderr) {
    process.stderr.write(str);
  } else if (typeof printErr !== 'undefined') {
    printErr(str);
  } else if (typeof putstr !== 'undefined') {
    putstr(str);
  } else if(typeof(console) !== 'undefined') {
    console.log(str);
  }
}

function h$performMajorGC() {
  // fixme
}


function h$baseZCSystemziCPUTimeZCgetrusage() {
  return 0;
}

function h$getrusage() {
  return 0;
}


// fixme need to fix these struct locations

function h$gettimeofday(tv_v,tv_o,tz_v,tz_o) {
  var now = Date.now();
  tv_v.dv.setInt32(tv_o,     (now / 1000)|0, true);
  tv_v.dv.setInt32(tv_o + 4, ((now % 1000) * 1000)|0, true);
  if(tv_v.len >= tv_o + 12) {
    tv_v.dv.setInt32(tv_o + 8, ((now % 1000) * 1000)|0, true);
  }
  return 0;
}

function h$traceEvent(ev_v,ev_o) {
  h$errorMsg(h$decodeUtf8z(ev_v, ev_o));
}

function h$traceMarker(ev_v,ev_o) {
  h$errorMsg(h$decodeUtf8z(ev_v, ev_o));
}

var h$__hscore_gettimeofday = h$gettimeofday;

var h$myTimeZone = h$encodeUtf8("UTC");
function h$localtime_r(timep_v, timep_o, result_v, result_o) {
  var t = timep_v.i3[timep_o];
  var d = new Date(t * 1000);
  result_v.dv.setInt32(result_o     , d.getSeconds(), true);
  result_v.dv.setInt32(result_o + 4 , d.getMinutes(), true);
  result_v.dv.setInt32(result_o + 8 , d.getHours(), true);
  result_v.dv.setInt32(result_o + 12, d.getDate(), true);
  result_v.dv.setInt32(result_o + 16, d.getMonth(), true);
  result_v.dv.setInt32(result_o + 20, d.getFullYear()-1900, true);
  result_v.dv.setInt32(result_o + 24, d.getDay(), true);
  result_v.dv.setInt32(result_o + 28, 0, true); // fixme yday 1-365 (366?)
  result_v.dv.setInt32(result_o + 32, -1, true); // dst information unknown
  result_v.dv.setInt32(result_o + 40, 0, true); // gmtoff?
  if(!result_v.arr) result_v.arr = [];
  result_v.arr[result_o + 40] = [h$myTimeZone, 0];
  result_v.arr[result_o + 48] = [h$myTimeZone, 0];
  h$ret1 = result_o;
  return result_v;
}
var h$__hscore_localtime_r = h$localtime_r;

// weak reference support

// h$Weak objects that still have finalizers
var h$weaks = new goog.structs.Set();

// var traceWeak = log;
function traceWeak() { return; }

// called by the GC with a set of still reachable
function h$finalizeWeaks() {
  var mark = h$gcMark;
  traceWeak("finalizeWeaks: " + mark);
  var iter = h$weaks.__iterator__();
  var toFinalize = [];
  var checked = 0;
  try {
    while(true) {
      checked++;
      var w = iter.next();
      traceWeak("key mark: " + w.key.m + " - " + mark);
      if(w.key.m === undefined || w.key.m & 3 !== mark) {
        toFinalize.push(w);
      }
    }
  } catch(e) { if(e !== goog.iter.StopIteration) { throw e; } }
  traceWeak("to finalize: " + toFinalize.length + " checked: " + checked);
  // start a finalizer thread if any finalizers need to be run
  if(toFinalize.length > 0) {
    var t = new h$Thread();
    for(var i=0;i<toFinalize.length;i++) {
      var w = toFinalize[i];
      t.sp += 6;
      t.stack[t.sp-5] = 0;      // mask
      t.stack[t.sp-4] = h$noop; // handler, dummy
      t.stack[t.sp-3] = h$catch_e;
      t.stack[t.sp-2] = h$ap_1_0;
      t.stack[t.sp-1] = w.finalizer;
      t.stack[t.sp]   = h$return;
      h$weaks.remove(w);
      w.key = null;
      w.val = null;
      w.finalizer = null;
    }
    h$wakeupThread(t);
  }
}

function h$Weak(key, val, finalizer) {
  traceWeak("making weak of: " + h$collectProps(key));
  if(key.f && key.f.n) { traceWeak("name: " + key.f.n); }
  this.key = key;
  this.val = val;
  this.finalizer = finalizer;
  if(finalizer !== null) { h$weaks.add(this); }
}

function h$makeWeak(key, val, fin) {
  return new h$Weak(key, val, fin)
}

function h$makeWeakNoFinalizer(key, val) {
  return new h$Weak(key, val, null);
}

function h$finalizeWeak(w) {
  if(w.finalizer === null) {
    return 0;
  } else {
    h$weaks.remove(w);
    h$ret1 = w.finalizer;
    w.finalizer = null;
    return 1;
  }
}


// preemptive threading support

// thread status
var h$threadRunning  = 0;
var h$threadBlocked  = 1;
var h$threadFinished = 16;
var h$threadDied     = 17;

var h$threadIdN = 0;

// all threads except h$currentThread
// that are not finished/died can be found here
var h$threads = new goog.structs.Queue();
var h$blocked = new goog.structs.Set();

function h$logSched() { return; }
// var h$logSched = h$logSched0;
function h$logSched0() { if(arguments.length == 1) {
                          if(h$currentThread != null) {
                            log((Date.now()/1000) + " sched: " + h$threadString(h$currentThread) +
                                "[" + h$currentThread.mask + "," +
                                (h$currentThread.interruptible?1:0) + "," +
                                h$currentThread.excep.length +
                                "] -> " + arguments[0]);
                          } else {
                            log("sched: " + h$threadString(h$currentThread) + " -> " + arguments[0]);
                          }
                        } else {
                          log.apply(log,arguments);
                        }
                      }

function h$Thread() {
  this.tid = ++h$threadIdN;
  this.status = h$threadRunning;
  this.stack = [h$done, 0, h$baseZCGHCziConcziSynczireportError, h$catch_e];
  this.sp = 3;
  this.mask = 0;         // async exceptions masked (0 unmasked, 1: uninterruptible, 2: interruptible)
  this.interruptible = false; // currently in an interruptible operation
  this.excep = [];       // async exceptions waiting for unmask of this thread
  this.delayed = false;  // waiting for threadDelay
  this.blockedOn = null; // object on which thread is blocked
  this.retryInterrupted = null; // how to retry blocking operation when interrupted
  this.transaction = null; // for STM
  this.m = 0;
}

function h$rts_getThreadId(t) {
  return t.tid;
}

function h$cmp_thread(t1,t2) {
  if(t1.tid < t2.tid) return -1;
  if(t1.tid > t2.tid) return 1;
  return 0;
}

// description of the thread, if unlabeled then just the thread id
function h$threadString(t) {
  if(t === null) {
    return "<no thread>";
  } else if(t.label) {
    var str = h$decodeUtf8z(t.label[0], t.label[1]);
    return str + " (" + t.tid + ")";
  } else {
    return (""+t.tid);
  }
}

function h$fork(a, inherit) {
  var t = new h$Thread();
  h$logSched("sched: forking: " + h$threadString(t));
  if(inherit && h$currentThread) {
    t.mask = h$currentThread.mask;
  }
  //h$logSched("sched: action forked: " + a.f.n);
  t.stack[4] = h$ap_1_0;
  t.stack[5] = a;
  t.stack[6] = h$return;
  t.sp = 6;
  h$wakeupThread(t);
  return t;
}

function h$threadStatus(t) {
  h$ret1 = 1; // capability
  h$ret2 = 0; // locked
  return t.status;
}

function h$waitRead(fd) {
  h$fds[fd].waitRead.push(h$currentThread);
  h$currentThread.interruptible = true;
  h$blockThread(h$currentThread,fd,[h$waitRead,fd]);
  return h$reschedule;
}

function h$waitWrite(fd) {
  h$fds[fd].waitWrite.push(h$currentThread);
  h$currentThread.interruptible = true;
  h$blockThread(h$currentThread,fd,[h$waitWrite,fd]);
  return h$reschedule;
}

// threadDelay support:
var h$delayed = new goog.structs.Heap();
function h$wakeupDelayed(now) {
  while(h$delayed.getCount() > 0 && h$delayed.peekKey() < now) {
    var t = h$delayed.remove();
    // might have been woken up early, don't wake up again in that case
    if(t.delayed) {
      t.delayed = false;
      h$wakeupThread(t);
    }
  }
}

function h$delayThread(time) {
  var now = Date.now();
  var ms = time/1000; // we have no microseconds in JS
  h$logSched("delaying " + h$threadString(h$currentThread) + " " + ms + "ms");
  h$delayed.insert(now+ms, h$currentThread);
  h$sp += 2;
  h$stack[h$sp-1] = h$r1;
  h$stack[h$sp] = h$return;
  h$currentThread.delayed = true;
  h$blockThread(h$currentThread, h$delayed,[h$resumeDelayThread]);
  return h$reschedule;
}

function h$resumeDelayThread() {
  h$r1 = false;
  return h$stack[h$sp];
}

function h$yield() {
  h$sp += 2;
  h$stack[h$sp-1] = h$r1;
  h$stack[h$sp] = h$return;
  h$currentThread.sp = h$sp;
  return h$reschedule;
}

// raise the async exception in the thread if not masked
function h$killThread(t, ex) {
  h$logSched("killThread: " + h$threadString(t));
  if(t === h$currentThread) {
    // if target is self, then throw even if masked
    h$sp += 2;
    h$stack[h$sp-1] = h$r1;
    h$stack[h$sp]   = h$return;
    return h$throw(ex,true);
  } else {
    h$logSched("killThread mask: " + t.mask);
    if(t.mask === 0 || (t.mask === 2 && t.interruptible)) {
      if(t.stack) {  // finished threads don't have a stack anymore
        h$forceWakeupThread(t);
        t.sp += 2;
        t.stack[t.sp-1] = ex;
        t.stack[t.sp] = h$raiseAsync_frame;
      }
      return h$stack[h$sp];
    } else {
      t.excep.push([h$currentThread,ex]);
      h$blockThread(h$currentThread,t,null);
      h$currentThread.interruptible = true;
      h$sp += 2;
      h$stack[h$sp-1] = h$r1;
      h$stack[h$sp] = h$return;
      return h$reschedule;
    }
  }
}

function h$maskStatus() {
  h$logSched("mask status: " + h$currentThread.mask);
  return h$currentThread.mask;
}

function h$maskAsync(a) {
  h$logSched("mask: thread " + h$threadString(h$currentThread));
  if(h$currentThread.mask !== 2) {
    if(h$currentThread.mask === 0 && h$stack[h$sp] !== h$maskFrame && h$stack[h$sp] !== h$maskUnintFrame) {
      h$stack[++h$sp] = h$unmaskFrame;
    }
    if(h$currentThread.mask === 1) {
      h$stack[++h$sp] = h$maskUnintFrame;
    }
    h$currentThread.mask = 2;
  }
  h$r1 = a;
  return h$ap_1_0_fast();
}

function h$maskUnintAsync(a) {
  h$logSched("mask unint: thread " + h$threadString(h$currentThread));
  if(h$currentThread.mask !== 1) {
    if(h$currentThread.mask === 2) {
      h$stack[++h$sp] = h$maskFrame;
    } else {
      h$stack[++h$sp] = h$unmaskFrame;
    }
    h$currentThread.mask = 1;
  }
  h$r1 = a;
  return h$ap_1_0_fast();
}

function h$unmaskAsync(a) {
  h$logSched("unmask: " + h$threadString(h$currentThread));
  if(h$currentThread.excep.length > 0) {
    h$currentThread.mask = 0;
    h$sp += 3;
    h$stack[h$sp-2] = h$ap_1_0;
    h$stack[h$sp-1] = a;
    h$stack[h$sp]   = h$return;
    return h$reschedule;
  }
  if(h$currentThread.mask !== 0) {
    if(h$stack[h$sp] !== h$unmaskFrame) {
      if(h$currentThread.mask === 2) {
        h$stack[++h$sp] = h$maskFrame;
      } else {
        h$stack[++h$sp] = h$maskUnintFrame;
      }
    }
    h$currentThread.mask = 0;
  }
  h$r1 = a;
  return h$ap_1_0_fast();
}

function h$pendingAsync() {
  var t = h$currentThread;
  return (t.excep.length > 0 && (t.mask === 0 || (t.mask === 2 && t.interruptible)));
}

// post the first of the queued async exceptions to
// this thread, restore frame is in thread if alreadySuspended

function h$postAsync(alreadySuspended,next) {
  var t = h$currentThread;
  if(h$pendingAsync()) {
    h$logSched("posting async to " + h$threadString(t) + " mask status: " + t.mask);
    var v = t.excep.shift();
    var tposter = v[0]; // posting thread, blocked
    var ex      = v[1]; // the exception
    if(v !== null && tposter !== null) {
      h$wakeupThread(tposter);
    }
    if(!alreadySuspended) {
      h$suspendCurrentThread(next);
    }
    h$sp += 2;
    h$stack[h$sp-1]    = ex;
    h$stack[h$sp]      = h$raiseAsync_frame;
    t.sp = h$sp;
    return true;
  } else {
    return false;
  }
}

// wakeup thread, thread has already been removed
// from any queues it was blocked on
function h$wakeupThread(t) {
  h$logSched("sched: waking up: " + h$threadString(t));
  if(t.status === h$threadBlocked) {
    t.blockedOn = null;
    t.status = h$threadRunning;
    h$blocked.remove(t);
  }
  t.interruptible = false;
  t.retryInterrupted = null;
  h$threads.enqueue(t);
}

// force wakeup, remove this thread from any
// queue it's blocked on
function h$forceWakeupThread(t) {
  h$logSched("forcing wakeup of: " + h$threadString(t));
  if(t.status === h$threadBlocked) {
    h$removeThreadBlock(t);
    h$wakeupThread(t);
  }
}

function h$removeThreadBlock(t) {
  if(t.status === h$threadBlocked) {
    var o = t.blockedOn;
    if(o === null || o === undefined) {
      throw ("h$removeThreadBlock: blocked on null or undefined: " + h$threadString(t));
    } else if(o === h$delayed) {
      // thread delayed, can't remove, wakeupDelayed will check
      t.delayed = false;
    } else if(o instanceof h$MVar) {
      h$logSched("blocked on MVar");
      h$logSched("MVar before: " + o.readers.getCount() + " " + o.writers.getCount());
      o.readers.remove(t);
      // fixme is there a better way, writers are [thread,val] pairs
      var q = new goog.structs.Queue();
      var w;
      while ((w = o.writers.dequeue()) !== undefined) {
        if(w[0] !== t) { q.enqueue(w); }
      }
      o.writers = q;
      h$logSched("MVar after: " + o.readers.getCount() + " " + o.writers.getCount());
    } else if(o instanceof h$Fd) {
      h$logSched("blocked on fd");
      h$removeFromArray(o.waitRead,t);
      h$removeFromArray(o.waitWrite,t);
    } else if(o instanceof h$Thread) {
      h$logSched("blocked on async exception");
      // set thread (first in pair) to null, exception will still be delivered
      // but this thread not woken up again
      // fixme: are these the correct semantics?
      for(var i=0;i<o.excep.length;i++) {
        if(o.excep[i][0] === t) {
          o.excep[i][0] = null;
          break;
        }
      }
    } else if (o instanceof h$TVarsWaiting) {
      h$stmRemoveBlockedThread(o.tvars, t)
    } else if(o.f && o.f.t === h$BLACKHOLE_CLOSURE) {
      h$logSched("blocked on blackhole");
      h$removeFromArray(o.d2,t);
    } else {
      throw ("h$removeThreadBlock: blocked on unknown object: " + h$collectProps(o));
    }
    if(t.retryInterrupted) {
      t.sp+=2;
      t.stack[t.sp-1] = t.retryInterrupted;
      t.stack[t.sp] = h$retryInterrupted;
    }
  }
}

function h$removeFromArray(a,o) {
  var i;
  while((i = a.indexOf(o)) !== -1) {
    a.splice(i,1);
  }
}

function h$finishThread(t) {
  h$logSched("sched: finishing: " + h$threadString(t));
  t.status = h$threadFinished;
  h$blocked.remove(t);
  t.stack = null;
  t.mask = 0;
  for(var i=0;i<t.excep.length;i++) {
    var v = t.excep[i];
    var tposter = v[0];
    if(v !== null && tposter !== null) {
      h$wakeupThread(tposter);
    }
  }
  t.excep = [];
}

function h$blockThread(t,o,resume) {
  h$logSched("sched: blocking: " + h$threadString(t));
  if(o === undefined || o === null) {
    throw ("h$blockThread, no block object: " + h$threadString(t));
  }
  t.status = h$threadBlocked;
  t.blockedOn = o;
  t.retryInterrupted = resume;
  t.sp = h$sp;
  h$blocked.add(t);
}

// the main scheduler, called from h$mainLoop
// returns null if nothing to do, otherwise
// the next function to run
var h$lastGc = Date.now();
var h$gcInterval = 1000; // ms
function h$scheduler(next) {
  h$logSched("sched: scheduler: " + h$sp);
  var now = Date.now();
  h$wakeupDelayed(now);
  // find the next runnable thread in the run queue
  // remove non-runnable threads
  if(h$currentThread && h$pendingAsync()) {
    h$logSched("sched: received async exception, continuing thread");
    if(h$currentThread.status !== h$threadRunning) {
      h$forceWakeupThread(h$currentThread);
      h$currentThread.status = h$threadRunning;
    }
    h$postAsync(next === h$reschedule, next);
    return h$stack[h$sp];
  }
  var t;
  while(t = h$threads.dequeue()) {
    if(t.status === h$threadRunning) { break; }
  }
  // if no other runnable threads, just continue current (if runnable)
  if(t === undefined) {
    h$logSched("sched: no other runnable threads");
    if(h$currentThread && h$currentThread.status === h$threadRunning) {
      // do gc after a while
      if(now - h$lastGc > h$gcInterval) {
        if(next !== h$reschedule && next !== null) {
          h$suspendCurrentThread(next);
          next = h$stack[h$sp];
        }
        h$gc(h$currentThread);
        h$stack = h$currentThread.stack;
        h$lastGc = Date.now();
      }
//      if(h$postAsync(next === h$reschedule, next)) {
//        h$logSched("sched: continuing: " + h$threadString(h$currentThread) + " (async posted)"); // fixme we can remove these, we handle async excep earlier
//        return h$stack[h$sp];  // async exception posted, jump to the new stack top
//      } else {
      h$logSched("sched: continuing: " + h$threadString(h$currentThread));
      return (next===h$reschedule || next === null)?h$stack[h$sp]:next; // just continue
    } else {
      h$logSched("sched: pausing");
      h$currentThread = null;
      h$gc(null);
      return null; // pause the haskell runner
    }
  } else { // runnable thread in t, switch to it
    h$logSched("sched: switching to: " + h$threadString(t));
    if(h$currentThread !== null) {
      if(h$currentThread.status === h$threadRunning) {
        h$threads.enqueue(h$currentThread);
      }
      // if h$reschedule called, thread takes care of suspend
      if(next !== h$reschedule && next !== null) {
        h$logSched("sched: suspending: " + h$threadString(h$currentThread));
        // suspend thread: push h$restoreThread stack frame
        h$suspendCurrentThread(next);
      } else {
        h$logSched("sched: no suspend needed, reschedule called from: " + h$threadString(h$currentThread));
        h$currentThread.sp = h$sp;
      }
      h$postAsync(true, next);
    } else {
      h$logSched("sched: no suspend needed, no running thread");
    }
    // gc if needed
    if(now - h$lastGc > h$gcInterval) {
      h$gc(t);
      h$lastGc = Date.now();
    }
    // schedule new one
    h$currentThread = t;
    h$stack = t.stack;
    h$sp = t.sp;
    h$logSched("sched: scheduling " + h$threadString(t) + " sp: " + h$sp);
    //h$logSched("sp thing: " + h$stack[h$sp].n);
    // h$dumpStackTop(h$stack,0,h$sp);
    return h$stack[h$sp];
  }
}

// untility function: yield h$run to browser to do layout or
// other JavaScript
var h$yieldRun;
// disable postMessage for now, messages sometimes do not arrive, killing our runtime
if(false) { // typeof window !== 'undefined' && window.postMessage) {
  // is this lower delay than setTimeout?
  var handler = function(ev) {
    if(ev.data === "h$mainLoop") { h$mainLoop(); }
  };
  if(window.addEventListener) {
    window.addEventListener("message", handler);
  } else {
    window.attachEvent("message", handler);
  }
  h$yieldRun = function() { h$running = false; window.postMessage("h$mainLoop", "*"); }
} else if(typeof process !== 'undefined' && process.nextTick) {
/*  h$yieldRun = function() {
    h$logSched("yieldrun process.nextTick");
    h$running = false;
    process.nextTick(h$mainLoop);
  } */
  h$yieldRun = null; // the above (and setTimeout) are extremely slow in node
} else if(typeof setTimeout !== 'undefined') {
  h$yieldRun = function() {
    h$logSched("yieldrun setTimeout");
    h$running = false;
    setTimeout(h$mainLoop, 0);
  }
} else {
  h$yieldRun = null; // SpiderMonkey shell has none of these
}

function h$startMainLoop() {
  if(h$yieldRun) {
    h$yieldRun();
  } else {
    h$mainLoop();
  }
}

var h$running = false;
var h$next = null;
function h$mainLoop() {
  if(h$running) return;
  h$running = true;
  h$run_init_static();
  h$currentThread = h$next;
  var c = null; // fixme is this ok?
  var count;
  var start = Date.now();
  do {
    c = h$scheduler(c);
    var scheduled = Date.now();
    if(c === null) { // no running threads
      h$running = false;
      if(typeof setTimeout !== 'undefined') {
        h$next = null;
        setTimeout(h$mainLoop, 20);
        return;
      } else {
        while(c === null) { c = h$scheduler(c); }
      }
    }
    // yield to js after 100ms
    if(Date.now() - start > 100) {
      h$logSched("yielding to js");
      if(h$yieldRun) {
        if(c !== h$reschedule) {
          h$suspendCurrentThread(c);
        }
        h$next = h$currentThread;
        h$currentThread = null;
        return h$yieldRun();
      }
    }
    // preemptively schedule threads after 9990 calls
    // but not earlier than after 25ms
    try {
      while(c !== h$reschedule && Date.now() - scheduled < 25) {
        count = 0;
        while(c !== h$reschedule && ++count < 1000) {
//          h$logCall(c);
//          h$logStack();
          c = c();
          c = c();
          c = c();
          c = c();
          c = c();
          c = c();
          c = c();
          c = c();
          c = c();
          c = c();
        }
      }
    } catch(e) {
      // uncaught exception in haskell code, kill thread
      // would we ever need to remove the thread from queues?
      h$currentThread.status = h$threadDied;
      h$currentThread.stack = null;
      h$currentThread = null;
      h$stack = null;
      c = null;
      console.log("uncaught exception in Haskell thread: " + e.toString());
    }
  } while(true);
}

// run the supplied IO action in a new thread
// returns immediately, thread is started in background
function h$run(a) {
  //h$logSched("sched: starting thread");
  var t = h$fork(a, false);
  h$startMainLoop();
  return t;
}

// try to run the supplied IO action synchronously, running the
// thread to completion, unless it blocks,
// for example by taking an MVar or threadDelay

// returns the thing the thread blocked on, null if the thread ran to completion

// cont :: bool, continue thread asynchronously after h$runSync returns
function h$runSync(a, cont) {
  h$run_init_static();
  var c = h$return;
  var t = new h$Thread();
  var ct = h$currentThread;
  var csp = h$sp;
  var cr1 = h$r1; // do we need to save more than this?
  t.stack[4] = h$ap_1_0;
  t.stack[5] = a;
  t.stack[6] = h$return;
  t.sp = 6;
  t.status = h$threadRunning;
  var excep = null;
  var blockedOn = null;
  h$currentThread = t;
  h$stack = t.stack;
  h$sp = t.sp;
  try {
    while(true) {
      h$logSched("h$runSync: entering main loop");
      while(c !== h$reschedule) {
//        h$logCall(c);
//        h$logStack();
        c = c();
        c = c();
        c = c();
        c = c();
        c = c();
      }
      h$logSched("h$runSync: main loop exited");
      if(t.status === h$threadFinished) {
        h$logSched("h$runSync: thread finished");
        break;
      } else {
        h$logSched("h$runSync: thread NOT finished");
      }
      var b = t.blockedOn;
      if(typeof b === 'object' && b && b.f && b.f.t === h$BLACKHOLE_CLOSURE) {
        var bhThread = b.d1;
        if(bhThread === ct || bhThread === t) { // hit a blackhole from running thread or ourselves
          h$logSched("h$runSync: NonTermination");
          c = h$throw(h$baseZCControlziExceptionziBasezinonTermination, false);
        } else { // blackhole from other thread, steal it if thread is running
          // switch to that thread
          if(h$runBlackholeThreadSync(b)) {
            h$logSched("h$runSync: blackhole succesfully removed");
            c = h$stack[h$sp];
          } else {
            h$logSched("h$runSync: blackhole not removed, failing");
            blockedOn = b;
            throw false;
          }
        }
      } else {
        h$logSched("h$runSync: blocked on something other than a blackhole");
        blockedOn = b;
        throw false;
      }
    }
  } catch(e) { excep = e; }
  if(ct !== null) {
    h$currentThread = ct;
    h$stack = ct.stack;
    h$sp = csp;
    h$r1 = cr1;
  }
  if(t.status !== h$threadFinished && !cont) {
    h$removeThreadBlock(t);
    h$finishThread(t);
  }
  if(excep) {
    throw excep;
  }
  return blockedOn;
  h$logSched("h$runSync: finishing");
}

// run other threads synchronously until the blackhole is 'freed'
// returns true for success, false for failure, a thread blocks
function h$runBlackholeThreadSync(bh) {
  h$logSched("trying to remove black hole");
  var ct = h$currentThread;
  var sp = h$sp;
  var success = false;
  var bhs = [];
  var currentBh  = bh;
  // we don't handle async exceptions here, don't run threads with pending exceptions
  if(bh.d1.excep.length > 0) {
    return false;
  }
  h$currentThread = bh.d1;
  h$stack = h$currentThread.stack;
  h$sp = h$currentThread.sp;
  var c = (h$currentThread.status === h$threadRunning)?h$stack[h$sp]:h$reschedule;
  h$logSched("switched thread status running: " + (h$currentThread.status === h$threadRunning));
  try {
    while(true) {
      while(c !== h$reschedule && currentBh.f.t === h$BLACKHOLE_CLOSURE) {
        c = c();
        c = c();
        c = c();
        c = c();
        c = c();
      }
      if(c === h$reschedule) { // perhaps new blackhole, then continue with that thread, otherwise fail
        if(typeof h$currentThread.blockedOn === 'object' &&
           h$currentThread.blockedOn.f &&
           h$currentThread.blockedOn.f.t === h$BLACKHOLE_CLOSURE) {
          h$logSched("following another black hole");
          bhs.push(currentBh);
          currentBh = h$currentThread.blockedOn;
          h$currentThread = h$currentThread.blockedOn.d1;
          if(h$currentThread.excep.length > 0) {
            break;
          }
          h$stack = h$currentThread.stack;
          h$sp = h$currentThread.sp;
          c = (h$currentThread.status === h$threadRunning)?h$stack[h$sp]:h$reschedule;
        } else {
          h$logSched("thread blocked on something that's not a black hole, failing");
          break;
        }
      } else { // blackhole updated: suspend thread and pick up the old one
        h$logSched("blackhole updated, switching back (" + h$sp + ")");
        h$logSched("next: " + c.toString());
        h$suspendCurrentThread(c);
        if(bhs.length > 0) {
          h$logSched("to next black hole");
          currentBh = bhs.pop();
          h$currentThread = currentBh.d1;
          h$stack = h$currentThread.stack;
          h$sp = h$currentThread.sp;
        } else {
          h$logSched("last blackhole removed, success!");
          success = true;
          break;
        }
      }
    }
  } catch(e) { }
  // switch back to original thread
  h$sp = sp;
  h$stack = ct.stack;
  h$currentThread = ct;
  return success;
}

// run the supplied IO action in a main thread
// (program exits when this thread finishes)
function h$main(a) {
  var t = new h$Thread();
  //h$logSched("sched: starting main thread");
  t.stack[0] = h$doneMain;
  t.stack[4] = h$ap_1_0;
  t.stack[5] = h$flushStdout;
  t.stack[6] = h$return;
  t.stack[7] = h$ap_1_0;
  t.stack[8] = a;
  t.stack[9] = h$return;
  t.sp = 9;
  t.label = [h$encodeUtf8("main"), 0];
  h$wakeupThread(t);
  h$startMainLoop();
  return t;
}

// MVar support
var h$mvarId = 0;
function h$MVar() {
  //h$logSched("h$MVar constructor");
  this.val     = null;
  this.readers = new goog.structs.Queue();
  this.writers = new goog.structs.Queue();
  this.waiters = null;  // waiting for a value in the MVar with ReadMVar
  this.m = 0;
  this.id = ++h$mvarId;
}

// set the MVar to empty unless there are writers
function h$notifyMVarEmpty(mv) {
  var w = mv.writers.dequeue();
  if(w !== undefined) {
    var thread = w[0];
    var val    = w[1];
    h$logSched("notifyMVarEmpty(" + mv.id + "): writer ready: " + h$threadString(thread));
    mv.val = val;
    // thread is null if some JavaScript outside Haskell wrote to the MVar
    if(thread !== null) {
      h$wakeupThread(thread);
    }
  } else {
    h$logSched("notifyMVarEmpty(" + mv.id + "): no writers");
    mv.val = null;
  }
  h$logSched("notifyMVarEmpty(" + mv.id + "): " + mv.val);
}

// set the MVar to val unless there are readers
function h$notifyMVarFull(mv,val) {
  if(mv.waiters && mv.waiters.length > 0) {
    for(var i=0;i<mv.waiters.length;i++) {
      var w = mv.waiters[i];
      w.sp += 2;
      w.stack[w.sp-1] = val;
      w.stack[w.sp]   = h$return;
      h$wakeupThread(w);
    }
    mv.waiters = null;
  }
  var r = mv.readers.dequeue();
  if(r !== undefined) {
    h$logSched("notifyMVarFull(" + mv.id + "): reader ready: " + h$threadString(r));
    r.sp += 2;
    r.stack[r.sp-1] = val;
    r.stack[r.sp]   = h$return;
    h$wakeupThread(r);
    mv.val = null;
  } else {
    h$logSched("notifyMVarFull(" + mv.id + "): no readers");
    mv.val = val;
  }
  h$logSched("notifyMVarFull(" + mv.id + "): " + mv.val);
}

function h$takeMVar(mv) {
  h$logSched("h$takeMVar(" + mv.id + "): " + mv.val + " " + h$threadString(h$currentThread));
  if(mv.val !== null) {
    h$r1 = mv.val;
    h$notifyMVarEmpty(mv);
    return h$stack[h$sp];
  } else {
    mv.readers.enqueue(h$currentThread);
    h$currentThread.interruptible = true;
    h$blockThread(h$currentThread,mv,[h$takeMVar,mv]);
    return h$reschedule;
  }
}

function h$tryTakeMVar(mv) {
  h$logSched("h$tryTakeMVar(" + mv.id + "): " + mv.val);
  if(mv.val === null) {
    h$ret1 = null;
    return 0;
  } else {
    h$ret1 = mv.val;
    h$notifyMVarEmpty(mv);
    return 1;
  }
}

function h$readMVar(mv) {
  h$logSched("h$readMVar(" + mv.id + "): " + mv.val);
  if(mv.val === null) {
    if(mv.waiters) {
      mv.waiters.push(h$currentThread);
    } else {
      mv.waiters = [h$currentThread];
    }
    h$currentThread.interruptible = true;
    h$blockThread(h$currentThread,mv,[h$readMVar,mv]);
    return h$reschedule;
  } else {
    h$r1 = mv.val;
    return h$stack[h$sp];
  }
}

function h$putMVar(mv,val) {
  h$logSched("h$putMVar(" + mv.id + "): " + mv.val);
  if(mv.val !== null) {
    mv.writers.enqueue([h$currentThread,val]);
    h$currentThread.interruptible = true;
    h$blockThread(h$currentThread,mv,[h$putMVar,mv]);
    return h$reschedule;
  } else {
    h$notifyMVarFull(mv,val);
    return h$stack[h$sp];
  }
}

function h$tryPutMVar(mv,val) {
  h$logSched("h$tryPutMVar(" + mv.id + "): " + mv.val);
  if(mv.val !== null) {
    return 0;
  } else {
    h$notifyMVarFull(mv,val);
    return 1;
  }
}

// box up a JavaScript value and write it to the MVar synchronously
function h$writeMVarJs1(mv,val) {
  var v = h$c1(h$data1_e, val);
  if(mv.val !== null) {
    h$logSched("h$writeMVarJs1: was full");
    mv.writers.enqueue([null,v]);
  } else {
    h$logSched("h$writeMVarJs1: was empty");
    h$notifyMVarFull(mv,v);
  }
}

function h$writeMVarJs2(mv,val1,val2) {
  var v = h$c2(h$data1_e, val1, val2);
  if(mv.val !== null) {
    h$logSched("h$writeMVarJs2: was full");
    mv.writers.enqueue([null,v]);
  } else {
    h$logSched("h$writeMVarJs2: was empty");
    h$notifyMVarFull(mv,v);
  }
}

// IORef support
function h$MutVar(v) {
  this.val = v;
  this.m = 0;
}

function h$atomicModifyMutVar(mv, fun) {
  var thunk = h$c2(h$ap1_e, fun, mv.val);
  mv.val = h$c1(h$select1_e, thunk);
  return h$c1(h$select2_e, thunk);
}

// Black holes and updates
// caller must save registers on stack
function h$blockOnBlackhole(c) {
  h$logSched("blackhole, blocking: " + h$collectProps(c));
  if(c.d1 === h$currentThread) {
    h$logSched("NonTermination");
    return h$throw(h$baseZCControlziExceptionziBasezinonTermination, false); // is this an async exception?
  }
  h$logSched("blackhole, blocking thread: " + h$threadString(h$currentThread));
  if(c.d2 === null) {
    c.d2 = [h$currentThread];
  } else {
    c.d2.push(h$currentThread);
  }
  h$blockThread(h$currentThread,c,[h$resumeBlockOnBlackhole,c]);
  return h$reschedule;
}

function h$resumeBlockOnBlackhole(c) {
  h$r1 = c;
  return h$ap_0_0_fast();
}

// async exception happened in a black hole, make a thunk
// to resume the computation
// var h$debugResumableId = 0;
function h$makeResumable(bh,start,end,extra) {
  var s = h$stack.slice(start,end+1);
  if(extra) {
    s = s.concat(extra);
  }
//  h$logSched("making resumable " + (h$debugResumableId+1) + ", stack: ");
//  h$dumpStackTop(s,0,s.length-1);
  bh.f = h$resume_e;
  bh.d1 = s;
  bh.d2 = null;
  //  bh.d2 = ++h$debugResumableId;
}

var h$enabled_capabilities = h$newByteArray(4);
h$enabled_capabilities.i3[0] = 1;

function h$rtsSupportsBoundThreads() {
  return 0;
}

// async foreign calls
function h$mkForeignCallback(x) {
  return function() {
    if(x.mv === null) { // callback called synchronously
      x.mv = arguments;
    } else {
      h$notifyMVarFull(x.mv, h$c1(h$data1_e, arguments));
    }
  }
}

// event listeners through MVar
function h$makeMVarListener(mv, stopProp, stopImmProp, preventDefault) {
  return function(event) {
    h$logSched("MVar listener callback");
    h$writeMVarJs1(mv,event);
    if(stopProp) { event.stopPropagation(); }
    if(stopImmProp) { event.stopImmediatePropagation(); }
    if(preventDefault) { event.preventDefault(); }
  }
}


// software transactional memory

function h$logStm() { return; }
// var h$logStm = h$logStm0;
function h$logStm0() { if(arguments.length == 1) {
                          log("stm: " + arguments[0]);
                        } else {
                          log.apply(log,arguments);
                        }
                      }


var h$stmTransactionActive = 0;
var h$stmTransactionWaiting = 4;

function h$Transaction(o, parent) {
  h$logStm("h$Transaction: " + o + " -> " + parent);
  this.action        = o;
  // h$TVar.id -> h$WrittenTVar, transaction-local changed values
  this.tvars         = new goog.structs.Map();
  // h$TVar.id -> h$LocalTVar, all local tvars accessed anywhere in the transaction
  this.accessed      = parent===null?new goog.structs.Map():parent.accessed;
  // nonnull while running a check, contains read variables in this part of the transaction
  this.checkRead     = parent===null?null:parent.checkRead;
  this.parent        = parent;
  this.state         = h$stmTransactionActive;
  this.invariants    = []; // invariants added in this transaction
}

function h$StmInvariant(a) {
  this.action = a;
}

function h$WrittenTVar(tv,v) {
  this.tvar = tv;
  this.val = v;
}

function h$TVar(v) {
  h$logStm("creating tvar, value: " + h$collectProps(v));
  this.val     = v;                         // current value
  this.blocked = new goog.structs.Set();    // threads that get woken up if this TVar is updated
  this.invariants = null;                   // invariants that use this tvar
}

function h$TVarsWaiting(s) {
  this.tvars = s;  // goog.structs.Set of TVars we're waiting on
}

function h$LocalInvariant(o) {
  this.action = o;
  this.dependencies = new goog.structs.Set();
}

// local view of a TVar
function h$LocalTVar(v) {
  h$logStm("creating tvar view for: " + h$collectProps(v));
  this.readVal = v.val;  // the value when read from environment
  this.val     = v.val;  // the current uncommitted value
  this.tvar    = v;
}

function h$atomically(o) {
  h$p3(o, h$atomically_e, h$checkInvariants_e);
  return h$stmStartTransaction(o);
}

function h$stmStartTransaction(o) {
  h$logStm("starting transaction: " + h$collectProps(o));
  var t = new h$Transaction(o, null);
  h$currentThread.transaction = t;
  h$r1 = o;
  return h$ap_1_0_fast();
}

function h$stmUpdateInvariantDependencies(inv) {
  var i = h$currentThread.transaction.checkRead.__iterator__();
  if(inv instanceof h$LocalInvariant) {
    try {
      while(true) {
        inv.dependencies.add(i.next());
      }
    } catch(e) { if(e !== goog.iter.StopIteration) { throw e; } }
  } else {
    try {
      while(true) {
        h$stmAddTVarInvariant(i.next(), inv);
      }
    } catch(e) { if(e !== goog.iter.StopIteration) { throw e; } }
  }
}

function h$stmAddTVarInvariant(tv, inv) {
  if(tv.invariants === null) {
    tv.invariants = new goog.structs.Set();
  }
  tv.invariants.add(inv);
}

// commit current transaction,
// if it's top-level, commit the tvars, otherwise commit to parent
function h$stmCommitTransaction() {
  var t = h$currentThread.transaction;
  var tvs = t.tvars;
  var i = tvs.getValueIterator();
  if(t.parent === null) { // real commit
    try {
      while(true) {
        var wtv = i.next();
        h$stmCommitTVar(wtv.tvar, wtv.val);
      }
    } catch(e) { if(e !== goog.iter.StopIteration) { throw e; } }
    for(var j=0;j<t.invariants.length;j++) {
      h$stmCommitInvariant(t.invariants[j]);
    }
  } else { // commit subtransaction
    var tpvs = t.parent.tvars;
    try {
      while(true) {
        var wtv = i.next();
        tpvs.set(goog.getUid(wtv.tvar), wtv);
      }
    } catch(e) { if(e !== goog.iter.StopIteration) { throw e; } }
    t.parent.invariants = t.parent.invariants.concat(t.invariants);
  }
  h$currentThread.transaction = t.parent;
}

function h$stmValidateTransaction() {
  var i = h$currentThread.transaction.accessed.getValueIterator();
  try {
    while(true) {
      var ltv = i.next();
      h$logStm("h$stmValidateTransaction: " + ltv);
      if(ltv.readVal !== ltv.tvar.val) return false;
    }
  } catch(e) { if(e !== goog.iter.StopIteration) { throw e; } }
  return true;
}

function h$stmAbortTransaction() {
  h$currentThread.transaction = h$currentThread.transaction.parent;
}


// add an invariant
function h$stmCheck(o) {
  h$currentThread.transaction.invariants.push(new h$LocalInvariant(o));
  return false;
}

function h$stmRetry() {
  // unwind stack to h$atomically_e or h$stmCatchRetry_e frame
  while(h$sp > 0) {
    var f = h$stack[h$sp];
    if(f === h$atomically_e || f === h$stmCatchRetry_e) {
      break;
    }
    var size;
    if(f === h$ap_gen) {
      size = ((h$stack[h$sp-1] >> 8) + 2);
    } else {
      var tag = f.gtag;
      if(tag < 0) { // dynamic size
        size = h$stack[h$sp-1];
      } else {
        size = (tag & 0xff) + 1;
      }
    }
    h$sp -= size;
  }
  // either h$sp == 0 or at a handler
  if(h$sp > 0) {
    if(f === h$atomically_e) {
      return h$stmSuspendRetry();
    } else { // h$stmCatchRetry_e
      var b = h$stack[h$sp-1];
      h$stmAbortTransaction();
      h$sp -= 2;
      h$r1 = b;
      return h$ap_1_0_fast();
    }
  } else {
    throw "h$stmRetry: STM retry outside a transaction";
  }
}

function h$stmSuspendRetry() {
  var i = h$currentThread.transaction.accessed.__iterator__();
  var tvs = new goog.structs.Set();
  try {
    while(true) {
      var tv = i.next().tvar;
      h$logStm("h$stmSuspendRetry, accessed: " + h$collectProps(tv));
      tv.blocked.add(h$currentThread);
      tvs.add(tv);
    }
  } catch(e) { if(e !== goog.iter.StopIteration) { throw e; } }
  waiting = new h$TVarsWaiting(tvs);
  h$blockThread(h$currentThread, waiting);
  h$p2(waiting, h$stmResumeRetry_e);
  return h$reschedule;
}

function h$stmCatchRetry(a,b) {
  h$currentThread.transaction = new h$Transaction(b, h$currentThread.transaction);
  h$p2(b, h$stmCatchRetry_e);
  h$r1 = a;
  return h$ap_1_0_fast();
}

function h$catchStm(a,handler) {
  h$p4(h$currentThread.transaction, h$currentThread.mask, handler, h$catchStm_e);
  h$r1 = a;
  return h$ap_1_0_fast();
}

var h$catchSTM = h$catchStm; // fixme remove after reboot

function h$newTVar(v) {
  return new h$TVar(v);
}

function h$readTVar(tv) {
  return h$readLocalTVar(h$currentThread.transaction,tv);
}

function h$readTVarIO(tv) {
  return tv.val;
}

function h$writeTVar(tv, v) {
  h$setLocalTVar(h$currentThread.transaction, tv, v);
}

function h$sameTVar(tv1, tv2) {
  return tv1 === tv2;
}

// get the local value of the TVar in the transaction t
// tvar is added to the read set
function h$readLocalTVar(t, tv) {
  if(t.checkRead !== null) {
    t.checkRead.add(tv);
  }
  var t0 = t;
  var tvi = goog.getUid(tv);
  while(t0 !== null) {
    var v = t0.tvars.get(tvi);
    if(v !== undefined) {
      h$logStm("h$readLocalTVar: found locally modified value: " + h$collectProps(v));
      return v.val;
    }
    t0 = t0.parent;
  }
  var lv = t.accessed.get(tvi);
  if(lv !== undefined) {
    h$logStm("h$readLocalTVar: found tvar value: " + h$collectProps(lv));
    return lv.val;
  } else {
    h$logStm("h$readLocalTVar: tvar value not found, adding: " + h$collectProps(tv));
    t.accessed.set(tvi, new h$LocalTVar(tv));
    return tv.val;
  }
}

function h$setLocalTVar(t, tv, v) {
  var tvi = goog.getUid(tv);
  if(!t.accessed.containsKey(tvi)) {
    t.accessed.set(tvi, new h$LocalTVar(tv));
  }
  if(t.tvars.containsKey(tvi)) {
    t.tvars.get(tvi).val = v;
  } else {
    t.tvars.set(tvi, new h$WrittenTVar(tv, v))
  }
}

function h$stmCheckInvariants() {
  var t = h$currentThread.transaction;
  function addCheck(inv) {
    h$p5(inv, h$stmCheckInvariantResult_e, t, inv, h$stmCheckInvariantStart_e);
  }
  h$p2(h$r1, h$return);
  var i = t.tvars.getValueIterator();
  try {
    while(true) {
      var wtv = i.next();
      h$logStm("h$stmCheckInvariants: checking: " + h$collectProps(wtv));
      var ii = wtv.tvar.invariants;
      if(ii) {
        var iii = ii.__iterator__();
        try {
          while(true) {
            addCheck(iii.next());
          }
        } catch(e) { if (e !== goog.iter.StopIteration) { throw e; } }
      }
    }
  } catch(e) { if(e !== goog.iter.StopIteration) { throw e; } }
  for(j=0;j<t.invariants.length;j++) {
    addCheck(t.invariants[j]);
  }
  return h$stack[h$sp];
}

function h$stmCommitTVar(tv, v) {
  if(v !== tv.val) {
    var iter = tv.blocked.__iterator__();
    try {
      while(true) {
        var thr = iter.next();
        if(thr.status === h$threadBlocked) {
          h$logStm("h$stmCommitTVar: waking up thread: " + h$threadString(thr));
          h$wakeupThread(thr);
        }
      }
    } catch(e) { if(e !== goog.iter.StopIteration) { throw e; } }
    tv.val = v;
  }
}

// remove the thread from the queues of the TVars in s
function h$stmRemoveBlockedThread(s, thread) {
  var i = s.tvars.__iterator__();
  try {
    while(true) {
      i.next().blocked.remove(thread);
    }
  } catch (e) { if(e !== goog.iter.StopIteration) { throw e; } }
}

function h$stmCommitInvariant(localInv) {
  var inv = new h$StmInvariant(localInv.action);
  var i = localInv.dependencies.__iterator__();
  try {
    while(true) {
      h$stmAddTVarInvariant(i.next(), inv);
    }
  } catch (e) { if(e !== goog.iter.StopIteration) { throw e; } }
}

function h$ghcjs_currentWindow() {
  return window;
};
function h$ghcjs_currentDocument() {
  return document;
};


/*
 * These hash functions were developed by Thomas Wang.
 *
 * http://www.concentric.net/~ttwang/tech/inthash.htm
 */

function h$hashable_wang_32(a) {
  a = (a ^ 61) ^ (a >> 16);
  a = a + (a << 3);
  a = a ^ (a >> 4);
  a = a * 0x27d4eb2d;
  a = a ^ (a >> 15);
  return a;
}

/*
uint64_t hashable_wang_64(uint64_t key)
{
    key = (~key) + (key << 21); // key = (key << 21) - key - 1;
    key = key ^ ((key >> 24) | (key << 40));
    key = (key + (key << 3)) + (key << 8); // key * 265
    key = key ^ ((key >> 14) | (key << 50));
    key = (key + (key << 2)) + (key << 4); // key * 21
    key = key ^ ((key >> 28) | (key << 36));
    key = key + (key << 31);
    return key;
}
*/

function h$_hs_text_memcpy(dst_v,dst_o2,src_v,src_o2,n) {
  return h$memcpy(dst_v,2*dst_o2,src_v,2*src_o2,2*n);
}

function h$_hs_text_memcmp(a_v,a_o2,b_v,b_o2,n) {
  return h$memcmp(a_v,2*a_o2,b_v,2*b_o2,2*n);
}

// decoder below adapted from cbits/cbits.c in the text package

/**
 * @define {number} size of Word and Int. If 64 we use goog.math.Long.
 */
var h$_text_UTF8_ACCEPT = 0;
/**
 * @define {number} size of Word and Int. If 64 we use goog.math.Long.
 */
var h$_text_UTF8_REJECT = 12

var h$_text_utf8d =
   [
  /*
   * The first part of the table maps bytes to character classes that
   * to reduce the size of the transition table and create bitmasks.
   */
   0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
   0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
   0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
   0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
   1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,  9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,
   7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,  7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
   8,8,2,2,2,2,2,2,2,2,2,2,2,2,2,2,  2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,
  10,3,3,3,3,3,3,3,3,3,3,3,3,4,3,3, 11,6,6,6,5,8,8,8,8,8,8,8,8,8,8,8,

  /*
   * The second part is a transition table that maps a combination of
   * a state of the automaton and a character class to a state.
   */
   0,12,24,36,60,96,84,12,12,12,48,72, 12,12,12,12,12,12,12,12,12,12,12,12,
  12, 0,12,12,12,12,12, 0,12, 0,12,12, 12,24,12,12,12,12,12,24,12,24,12,12,
  12,12,12,12,12,12,12,24,12,12,12,12, 12,24,12,12,12,12,12,12,12,24,12,12,
  12,12,12,12,12,12,12,36,12,36,12,12, 12,36,12,12,12,12,12,36,12,36,12,12,
  12,36,12,12,12,12,12,12,12,12,12,12];

/*
 * A best-effort decoder. Runs until it hits either end of input or
 * the start of an invalid byte sequence.
 *
 * At exit, updates *destoff with the next offset to write to, and
 * returns the next source offset to read from.
 */

function h$_hs_text_decode_utf8( dest_v
                               , destoff_v, destoff_o
                               , src_v, src_o
                               , src_end_v, src_end_o
                               ) {
  var dsto = destoff_v.dv.getUint32(destoff_o,true);
  var srco = src_o;
  var state = h$_text_UTF8_ACCEPT;
  var codepoint;
  var ddv = dest_v.dv;
  var sdv = src_v.dv;

  function decode(byte) {
    var type = h$_text_utf8d[byte];
    codepoint = (state !== h$_text_UTF8_ACCEPT) ?
      (byte & 0x3f) | (codepoint << 6) :
      (0xff >>> type) & byte;
    state = h$_text_utf8d[256 + state + type];
    return state;
  }
  while (srco < src_end_o) {
    if(decode(sdv.getUint8(srco++)) !== h$_text_UTF8_ACCEPT) {
      if(state !== h$_text_UTF8_REJECT) {
        continue;
      } else {
        break;
      }
    }
    if (codepoint <= 0xffff) {
      ddv.setUint16(dsto,codepoint,true);
      dsto += 2;
    } else {
      ddv.setUint16(dsto,(0xD7C0 + (codepoint >> 10)),true);
      ddv.setUint16(dsto+2,(0xDC00 + (codepoint & 0x3FF)),true);
      dsto += 4;
    }
  }

  /* Error recovery - if we're not in a valid finishing state, back up. */
  if (state != h$_text_UTF8_ACCEPT)
    srco -= 1;

  destoff_v.dv.setUint32(destoff_o,dsto>>1,true);
  h$ret1 = srco;
  return src_v;
}


