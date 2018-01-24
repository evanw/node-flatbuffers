var flatbuffers = require('./flatbuffers').flatbuffers;
var reflection = require('./reflection_generated').reflection;

var baseTypes = [
  'None',
  'UType',
  'Bool',
  'Byte',
  'UByte',
  'Short',
  'UShort',
  'Int',
  'UInt',
  'Long',
  'ULong',
  'Float',
  'Double',
  'String',
  'Vector',
  'Obj',
  'Union',
];

var scalarSizes = {
  'Bool': 1,
  'Byte': 1,
  'UByte': 1,
  'Short': 2,
  'UShort': 2,
  'Int': 4,
  'UInt': 4,
  'Long': 8,
  'ULong': 8,
  'Float': 4,
  'Double': 8,
};

var scalarGetters = {
  'Bool': '!!bb.readUint8',
  'Byte': 'bb.readInt8',
  'UByte': 'bb.readUint8',
  'Short': 'bb.readInt16',
  'UShort': 'bb.readUint16',
  'Int': 'bb.readInt32',
  'UInt': 'bb.readUint32',
  'Long': 'bb.readInt64',
  'ULong': 'bb.readUint64',
  'Float': 'bb.readFloat32',
  'Double': 'bb.readFloat64',
};

var scalarSetters = {
  'Bool': 'fbb.writeInt8',
  'Byte': 'fbb.writeInt8',
  'UByte': 'fbb.writeInt8',
  'Short': 'fbb.writeInt16',
  'UShort': 'fbb.writeInt16',
  'Int': 'fbb.writeInt32',
  'UInt': 'fbb.writeInt32',
  'Float': 'fbb.writeFloat32',
  'Double': 'fbb.writeFloat64',
};

var scalarAdders = {
  'Bool': 'fbb.addFieldInt8',
  'Byte': 'fbb.addFieldInt8',
  'UByte': 'fbb.addFieldInt8',
  'Short': 'fbb.addFieldInt16',
  'UShort': 'fbb.addFieldInt16',
  'Int': 'fbb.addFieldInt32',
  'UInt': 'fbb.addFieldInt32',
  'Float': 'fbb.addFieldFloat32',
  'Double': 'fbb.addFieldFloat64',
};

function notReached() {
  throw new Error('Internal error');
}

function requireUint8Array(bytes) {
  if (bytes instanceof Uint8Array) {
    return bytes;
  }

  if (typeof Buffer !== 'undefined' && bytes instanceof Buffer) {
    return new Uint8Array(bytes);
  }

  throw new Error('Not a valid Uint8Array');
}

function requireObject(json) {
  if (json instanceof Object) {
    return json;
  }

  throw new Error('Not a valid JSON object');
}

function parseValue(integer, real, type) {
  switch (type.baseType) {
    case 'Bool': return !!integer.low;
    case 'Byte': return integer.low << 24 >> 24;
    case 'UByte': case 'UType': return integer.low & 0xFF;
    case 'Short': return integer.low << 16 >> 16;
    case 'UShort': return integer.low & 0xFFFF;
    case 'Int': return integer.low | 0;
    case 'UInt': return integer.low >>> 0;
    case 'Long': return { low: integer.low | 0, high: integer.high | 0 };
    case 'ULong': return { low: integer.low >>> 0, high: integer.high >>> 0 };
    case 'Float': case 'Double': return real;
  }

  return null;
}

function parseType(type) {
  return {
    baseType: baseTypes[type.baseType()],
    element: baseTypes[type.element()],
    index: type.index(),
  };
}

function parseObject(object) {
  var result = {
    name: object.name(),
    isStruct: object.isStruct(),
    minalign: object.minalign(),
    bytesize: object.bytesize(),
    fields: [],
  };

  for (var i = 0, fieldsLength = object.fieldsLength(); i < fieldsLength; i++) {
    var field = object.fields(i);
    var type = parseType(field.type());

    result.fields.push({
      name: field.name(),
      type: type,
      id: field.id(),
      offset: field.offset(),
      deprecated: field.deprecated(),
      required: field.required(),
      key: field.key(),
      default: parseValue(field.defaultInteger(), field.defaultReal(), type),
    });
  }

  // Sort fields in order of id
  result.fields.sort(function(a, b) {
    return a.id - b.id;
  });

  return result;
}

function parseEnum(enumDef) {
  var type = parseType(enumDef.underlyingType());
  var result = {
    name: enumDef.name(),
    is_union: enumDef.isUnion(),
    underlying_type: type,
    values: [],
  };

  for (var i = 0, valuesLength = enumDef.valuesLength(); i < valuesLength; i++) {
    var value = enumDef.values(i);
    var object = value.object();

    result.values.push({
      name: value.name(),
      value: parseValue(value.value(), 0, type),
      object: object === null ? null : parseObject(object),
    });
  }

  // Sort values in order of value
  result.values.sort(function(a, b) {
    return a.value - b.value;
  });

  return result;
}

exports.parseSchema = function(bytes) {
  var bb = new flatbuffers.ByteBuffer(requireUint8Array(bytes));

  // Must conform to reflection.fbs
  if (!reflection.Schema.bufferHasIdentifier(bb)) {
    throw new Error('Not a valid binary FlatBuffers schema');
  }

  var schema = reflection.Schema.getRootAsSchema(bb);
  var result = {
    fileIdent: schema.fileIdent(),
    fileExt: schema.fileExt(),
    rootTable: parseObject(schema.rootTable()),
    objects: [],
    enums: [],
  };

  for (var i = 0, objectsLength = schema.objectsLength(); i < objectsLength; i++) {
    result.objects.push(parseObject(schema.objects(i)));
  }

  for (var i = 0, enumsLength = schema.enumsLength(); i < enumsLength; i++) {
    result.enums.push(parseEnum(schema.enums(i)));
  }

  return result;
};

function compileEnumGenerator(schema, context, enumDef) {
  var key = 'enumMap' + enumDef.name.replace(/\./g,'_');
  var code = '';

  if (key in context) {
    return key;
  }

  var map = {};

  for (var i = 0; i < enumDef.values.length; i++) {
    var value = enumDef.values[i];
    map[value.name] = value.value;
  }

  context[key] = map;

  return key;
}

function compileObjectGenerator(schema, context, object) {
  var key = 'generate' + object.name.replace(/\./g,'_');
  var code = '';

  if (key in context) {
    return key;
  }

  context[key] = null;

  // Structs
  if (object.isStruct) {
    code += 'fbb.prep(' + object.minalign + ', ' + object.bytesize + ');\n';

    // Write out fields backwards so they will be read in forwards
    for (var i = object.fields.length - 1; i >= 0; i--) {
      var field = object.fields[i];
      var type = field.type;
      var baseType = type.baseType;
      var setter = scalarSetters[baseType];
      var inlineSize = baseType === 'Obj' ? schema.objects[type.index].bytesize : scalarSizes[baseType];
      var nextOffset = i + 1 < object.fields.length ? object.fields[i + 1].offset : object.bytesize;
      var padding = nextOffset - field.offset - inlineSize;

      // Padding after the value
      if (padding) {
        code += 'fbb.pad(' + padding + ');\n';
      }

      // Scalars
      if (setter) {
        var enumDef = schema.enums[type.index];
        if (enumDef) {
          var nested = compileEnumGenerator(schema, context, enumDef);
          code += setter + '(context.' + nested + '[json.' + field.name + ']);\n';
        } else {
          code += setter + '(json.' + field.name + ');\n';
        }
      }

      // Longs
      else if (baseType === 'Long' || baseType === 'ULong') {
        code += 'fbb.writeInt64(fbb.createLong(json.' + field.name + '.low, json.' + field.name + '.high));\n';
      }

      // Structs
      else if (baseType === 'Obj') {
        var def = schema.objects[type.index];
        var nested = compileObjectGenerator(schema, context, def);
        code += 'context.' + nested + '(fbb, context, json.' + field.name + ');\n';
      }

      // Sanity check
      else {
        notReached();
      }
    }

    code += 'return fbb.offset();\n';
  }

  // Tables
  else {
    for (var i = 0; i < object.fields.length; i++) {
      var field = object.fields[i];
      var type = field.type;
      var baseType = type.baseType;

      // Skip deprecated fields
      if (field.deprecated) {
        continue;
      }

      // Strings
      if (baseType === 'String') {
        code += 'var offset' + field.id + ' = json.' + field.name + ' ? fbb.createString(json.' + field.name + ') : 0;\n';
      }

      // Tables
      else if (baseType === 'Obj' && !schema.objects[type.index].isStruct) {
        var def = schema.objects[type.index];
        var nested = compileObjectGenerator(schema, context, def);
        code += 'var offset' + field.id + ' = json.' + field.name + ' ? context.' + nested + '(fbb, context, json.' + field.name + ') : 0;\n';
      }

      // Vectors
      else if (baseType === 'Vector') {
        var element = type.element;
        var elementSetter = scalarSetters[element];

        // Check value
        code += 'var values = json.' + field.name + ';\n';
        code += 'var offset' + field.id + ' = 0;\n';
        code += 'if (values && values.length) {\n';

        // Vectors of strings
        if (element === 'String') {
          code += '  var offsets = [];\n';
          code += '  for (var i = 0; i < values.length; i++) {\n';
          code += '    offsets.push(fbb.createString(values[i]));\n';
          code += '  }\n';
        }

        // Vectors of tables
        else if (element === 'Obj' && !schema.objects[type.index].isStruct) {
          var def = schema.objects[type.index];
          var nested = compileObjectGenerator(schema, context, def);
          code += '  var offsets = [];\n';
          code += '  for (var i = 0; i < values.length; i++) {\n';
          code += '    offsets.push(context.' + nested + '(fbb, context, values[i]));\n';
          code += '  }\n';
        }

        // Begin vector (write out elements backwards so they will be read in forwards)
        code += '  fbb.startVector(8, values.length, 4);\n';
        code += '  for (var i = values.length - 1; i >= 0; i--) {\n';

        // Vectors of scalars
        if (elementSetter) {
          var enumDef = schema.enums[type.index];
          if (enumDef) {
            var nested = compileEnumGenerator(schema, context, enumDef);
            code += '    ' + elementSetter + '(context.' + nested + '[values[i]]);\n';
          } else {
            code += '    ' + elementSetter + '(values[i]);\n';
          }
        }

        // Vectors of longs
        else if (element === 'Long' || element === 'ULong') {
          code += '    fbb.writeInt64(fbb.createLong(values[i].low, values[i].high));\n';
        }

        // Vectors of structs
        else if (element === 'Obj' && schema.objects[type.index].isStruct) {
          var def = schema.objects[type.index];
          var nested = compileObjectGenerator(schema, context, def);
          code += '    context.' + nested + '(fbb, context, values[i]);\n';
        }

        // Vectors of strings or tables
        else if (element === 'String' || element === 'Obj') {
          code += '    fbb.addOffset(offsets[i]);\n';
        }

        // Sanity check
        else {
          notReached();
        }

        // End loop
        code += '  }\n';
        code += '  offset' + field.id + ' = fbb.endVector();\n';
        code += '}\n';
      }

      // Unions
      else if (baseType === 'Union') {
        throw new Error('Unions are not supported yet');
      }
    }

    code += 'fbb.startObject(' + object.fields.length + ');\n';

    for (var i = 0; i < object.fields.length; i++) {
      var field = object.fields[i];
      var type = field.type;
      var baseType = type.baseType;
      var adder = scalarAdders[baseType];

      // Skip deprecated fields
      if (field.deprecated) {
        continue;
      }

      // Scalars
      if (adder) {
        code += 'if (' + JSON.stringify(field.name) + ' in json) {\n';
        var enumDef = schema.enums[type.index];
        if (enumDef) {
          var nested = compileEnumGenerator(schema, context, enumDef);
          code += '  ' + adder + '(' + field.id + ', context.' + nested + '[json.' + field.name + '], ' + JSON.stringify(field.default) + ');\n';
        } else {
          code += '  ' + adder + '(' + field.id + ', json.' + field.name + ', ' + JSON.stringify(field.default) + ');\n';
        }
        code += '}\n';
      }

      // Longs
      else if (baseType === 'Long' || baseType === 'ULong') {
        code += 'if (json.' + field.name + ') {\n';
        code += '  fbb.addFieldInt64(' + field.id + ',\n';
        code += '    fbb.createLong(json.' + field.name + '.low, json.' + field.name + '.high),\n';
        code += '    fbb.createLong(' + field.default.low + ', ' + field.default.high + '));\n';
        code += '}\n';
      }

      // Structs
      else if (baseType === 'Obj' && schema.objects[type.index].isStruct) {
        var def = schema.objects[type.index];
        var nested = compileObjectGenerator(schema, context, def);
        code += 'fbb.addFieldStruct(' + field.id + ', json.' + field.name + ' ? context.' + nested + '(fbb, context, json.' + field.name + ') : 0, 0);\n';
      }

      // Strings or tables or vectors
      else if (baseType === 'String' || baseType === 'Obj' || baseType === 'Vector') {
        code += 'fbb.addFieldOffset(' + field.id + ', offset' + field.id + ', 0);\n';
      }

      // Unions
      else if (baseType === 'UType' || baseType === 'Union') {
        throw new Error('Unions are not supported yet');
      }

      // Sanity check
      else {
        notReached();
      }
    }

    code += 'var offset = fbb.endObject();\n';

    // Required fields
    for (var i = 0; i < object.fields.length; i++) {
      var field = object.fields[i];
      if (field.required) {
        code += 'fbb.requiredField(offset, ' + field.offset + ', ' + JSON.stringify(field.name) + ');\n';
      }
    }

    code += 'return offset;\n';
  }

  // Compile this code using the JIT
  context[key] = new Function('fbb', 'context', 'json', code);

  return key;
}

function compileEnumParser(schema, context, enumDef) {
  var key = 'enumArray' + enumDef.name.replace(/\./g,'_');
  var code = '';

  if (key in context) {
    return key;
  }

  var array = [];

  for (var i = 0; i < enumDef.values.length; i++) {
    var value = enumDef.values[i];
    array[value.value] = value.name;
  }

  context[key] = array;

  return key;
}

function compileObjectParser(schema, context, object) {
  var key = 'parse' + object.name.replace(/\./g,'_');
  var code = '';

  if (key in context) {
    return key;
  }

  context[key] = null;
  code += 'var json = {};\n';

  // Structs
  if (object.isStruct) {
    for (var i = 0; i < object.fields.length; i++) {
      var field = object.fields[i];
      var type = field.type;
      var baseType = type.baseType;
      var getter = scalarGetters[baseType];

      // Scalars
      if (getter) {
        var value = getter + '(bb_pos + ' + field.offset + ')';
        var enumDef = schema.enums[type.index];
        if (enumDef) {
          var nested = compileEnumParser(schema, context, enumDef);
          code += 'json.' + field.name + ' = context.' + nested + '[' + value + '];\n';
        } else {
          code += 'json.' + field.name + ' = ' + value + ';\n';
        }
      }

      // Structs
      else if (baseType === 'Obj') {
        var def = schema.objects[type.index];
        var nested = compileObjectParser(schema, context, def);
        code += 'json.' + field.name + ' = context.' + nested + '(bb, context, bb_pos + ' + field.offset + ');\n';
      }

      // Sanity check
      else {
        notReached();
      }
    }
  }

  // Tables
  else {
    for (var i = 0; i < object.fields.length; i++) {
      var field = object.fields[i];
      var type = field.type;
      var baseType = type.baseType;
      var getter = scalarGetters[baseType];

      // Skip deprecated fields
      if (field.deprecated) {
        continue;
      }

      // Common vtable offset lookup
      code += 'var offset = bb.__offset(bb_pos, ' + field.offset + ');\n';

      // Scalars
      if (getter) {
        var value = 'offset ? ' + getter + '(bb_pos + offset) : ' + JSON.stringify(field.default);
        var enumDef = schema.enums[type.index];
        if (enumDef) {
          var nested = compileEnumParser(schema, context, enumDef);
          code += 'json.' + field.name + ' = context.' + nested + '[' + value + '];\n';
        } else {
          code += 'json.' + field.name + ' = ' + value + ';\n';
        }
      }

      // Strings
      else if (baseType === 'String') {
        code += 'json.' + field.name + ' = offset ? bb.__string(bb_pos + offset) : null;\n';
      }

      // Tables or structs
      else if (baseType === 'Obj') {
        var def = schema.objects[type.index];
        var value = def.isStruct ? 'bb_pos + offset' : 'bb.__indirect(bb_pos + offset)';
        var nested = compileObjectParser(schema, context, def);
        code += 'json.' + field.name + ' = offset ? context.' + nested + '(bb, context, ' + value + ') : null;\n';
      }

      // Vectors
      else if (baseType === 'Vector') {
        var element = type.element;
        var elementGetter = scalarGetters[element];

        // Begin loop
        code += 'var values = [];\n';
        code += 'if (offset) {\n';
        code += '  for (var i = 0, n = bb.__vector_len(bb_pos + offset), item = bb.__vector(bb_pos + offset); i < n; i++) {\n';

        // Vectors of scalars
        if (elementGetter) {
          var enumDef = schema.enums[type.index];
          if (enumDef) {
            var nested = compileEnumParser(schema, context, enumDef);
            code += '    values.push(context.' + nested + '[' + elementGetter + '(item)]);\n';
          } else {
            code += '    values.push(' + elementGetter + '(item));\n';
          }
          code += '    item += ' + scalarSizes[element] + ';\n';
        }

        // Vectors of strings
        else if (element === 'String') {
          code += '    values.push(bb.__string(item));\n';
          code += '    item += 4;\n';
        }

        // Vectors of tables or structs
        else if (element === 'Obj') {
          var def = schema.objects[type.index];
          var nested = compileObjectParser(schema, context, def);
          var value = def.isStruct ? 'item' : 'bb.__indirect(item)';
          code += '    values.push(context.' + nested + '(bb, context, ' + value + '));\n';
          code += '    item += ' + (def.bytesize || 4) + ';\n';
        }

        // Sanity check
        else {
          notReached();
        }

        // End loop
        code += '  }\n';
        code += '}\n';
        code += 'json.' + field.name + ' = values;\n';
      }

      // Unions
      else if (baseType === 'UType' || baseType === 'Union') {
        throw new Error('Unions are not supported yet');
      }

      // Sanity check
      else {
        notReached();
      }
    }
  }

  // Compile this code using the JIT
  code += 'return json;\n';
  context[key] = new Function('bb', 'context', 'bb_pos', code);

  return key;
}

exports.compileSchema = function(bytesOrJson) {
  var schema = bytesOrJson;
  var bytes;

  // Allow passing the schema either as raw bytes or as a pre-parsed object literal
  try { bytes = requireUint8Array(bytesOrJson); } catch (e) {}
  if (bytes) schema = exports.parseSchema(bytes);

  // Quick sanity check to catch mistakes
  if (!(schema instanceof Object) || !('rootTable' in schema)) {
    throw new Error('Not a valid schema');
  }

  var context = {};
  var rootGenerator = context[compileObjectGenerator(schema, context, schema.rootTable)];
  var rootParser = context[compileObjectParser(schema, context, schema.rootTable)];

  return {
    generate: function(json) {
      var fbb = new flatbuffers.Builder();
      fbb.finish(rootGenerator(fbb, context, requireObject(json)), schema.fileIdent);
      return fbb.asUint8Array();
    },

    parse: function(bytes) {
      var bb = new flatbuffers.ByteBuffer(requireUint8Array(bytes));
      return rootParser(bb, context, bb.readInt32(bb.position()) + bb.position());
    },
  };
};
