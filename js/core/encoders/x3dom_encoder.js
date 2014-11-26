/**
 *  Copyright (C) 2014 3D Repo Ltd
 *
 *  This program is free software: you can redistribute it and/or modify
 *  it under the terms of the GNU Affero General Public License as
 *  published by the Free Software Foundation, either version 3 of the
 *  License, or (at your option) any later version.
 *
 *  This program is distributed in the hope that it will be useful,
 *  but WITHOUT ANY WARRANTY; without even the implied warranty of
 *  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *  GNU Affero General Public License for more details.
 *
 *  You should have received a copy of the GNU Affero General Public License
 *  along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

/* global module */

var C = require("../constants.js");
var fs = require('fs');
var repoNodeMesh = require('../repoNodeMesh.js');

var xml_dom = require('xmldom');
var dom_imp = xml_dom.DOMImplementation;
var xml_serial = xml_dom.XMLSerializer;

var config = require('app-config').config;

var log_iface = require('../logger.js');
var logger = log_iface.logger;

var sem = require('semaphore')(10);

var json_cache = {};
var pbf_levels = 10;

function genPopCache(mesh) {
    if (!('pbf_cache' in GLOBAL)) {
        GLOBAL.pbf_cache = {};
        logger.log('debug', 'Created cache');
    }

    if (!(mesh['id'] in GLOBAL.pbf_cache)) {
        var bbox = repoNodeMesh.extractBoundingBox(mesh);
        var valid_tri = Array(mesh.faces_count);
        var vertex_map = new Array(mesh.vertices_count);
        var vertex_quant_idx = new Array(mesh.vertices_count);
        var vertex_quant = new Array(mesh.vertices_count);

        var new_vertex_id = 0;

        var vertex_values = new Array(mesh.vertices_count);
        var tri = new Array(mesh.faces_count);
        var normal_values = new Array(mesh.vertices_count);
        var tex_coords = new Array(mesh.vertices_count);

        var vert_num = 0;
        var vert_idx = 0;
        var comp_idx = 0;

        var has_tex = false;

        if ('uv_channels' in mesh) {
            if (mesh['uv_channels_count'] == 2) {
                logging.log('error', 'Only support two channels texture coordinates');
                return null;
            } else {
                has_tex = true;
            }
        }

        var min_texcoordu = 0;
        var max_texcoordu = 0;
        var min_texcoordv = 0;
        var max_texcoordv = 0;

        for (vert_num = 0; vert_num < mesh.vertices_count; vert_num++) {
            vertex_map[vert_num] = -1;

            vertex_values[vert_num] = [];
            normal_values[vert_num] = [];
            tex_coords[vert_num] = [];

            for (comp_idx = 0; comp_idx < 3; comp_idx++) {
                vertex_values[vert_num][comp_idx] = mesh.vertices.buffer.readFloatLE(12 * vert_num + 4 * comp_idx);
                normal_values[vert_num][comp_idx] = mesh.normals.buffer.readFloatLE(12 * vert_num + 4 * comp_idx);
            }

            if (has_tex) {
                for (comp_idx = 0; comp_idx < 2; comp_idx++) {
                    tex_coords[vert_num][comp_idx] = mesh.uv_channels.buffer.readFloatLE(8 * vert_num + 4 * comp_idx);

                    if (comp_idx == 0) {
                        if (vert_num == 0) {
                            min_texcoordu = tex_coords[vert_num][comp_idx];
                            max_texcoordu = tex_coords[vert_num][comp_idx];
                        } else {
                            if (tex_coords[vert_num][comp_idx] < min_texcoordu) min_texcoordu = tex_coords[vert_num][comp_idx];
                            if (tex_coords[vert_num][comp_idx] > max_texcoordu) max_texcoordu = tex_coords[vert_num][comp_idx];
                        }
                    }

                    if (comp_idx == 1) {
                        if (vert_num == 0) {
                            min_texcoordv = tex_coords[vert_num][comp_idx];
                            max_texcoordv = tex_coords[vert_num][comp_idx];
                        } else {
                            if (tex_coords[vert_num][comp_idx] < min_texcoordv) min_texcoordv = tex_coords[vert_num][comp_idx];
                            if (tex_coords[vert_num][comp_idx] > max_texcoordv) max_texcoordv = tex_coords[vert_num][comp_idx];
                        }
                    }
                }
            }
        }

        for (var tri_num = 0; tri_num < mesh.faces_count; tri_num++) {
            valid_tri[tri_num] = false;

            tri[tri_num] = [];

            for (vert_idx = 0; vert_idx < 3; vert_idx++) {
                tri[tri_num][vert_idx] = mesh.faces.buffer.readInt32LE(16 * tri_num + 4 * (vert_idx + 1));
            }
        }

        GLOBAL.pbf_cache[mesh['id']] = {};

        var lod = 0;
        var buf_offset = 0;

        var added_verts = 0;
        var prev_added_verts = 0;
        var max_bits = 16;
        var max_quant = Math.pow(2, max_bits) - 1;

        var stride = has_tex ? 16 : 12;
        GLOBAL.pbf_cache[mesh['id']].stride = stride;

        GLOBAL.pbf_cache[mesh['id']].min_texcoordu = min_texcoordu;
        GLOBAL.pbf_cache[mesh['id']].max_texcoordu = max_texcoordu;
        GLOBAL.pbf_cache[mesh['id']].min_texcoordv = min_texcoordv;
        GLOBAL.pbf_cache[mesh['id']].max_texcoordv = max_texcoordv;

        if (has_tex) GLOBAL.pbf_cache[mesh['id']].has_tex = has_tex;

        while ((new_vertex_id < mesh.vertices_count) && (lod < 16)) {
            logger.log('debug', 'Mesh ' + mesh['id'] + ' - Generating LOD ' + lod);
            var idx_buf = new Buffer(2 * 3 * mesh.faces_count);
            var vert_buf = new Buffer(stride * mesh.vertices_count);

            var vert_buf_ptr = 0;
            var idx_buf_ptr = 0;
            var dim = Math.pow(2, (max_bits - lod));

            // For all non mapped vertices compute quantization
            for (vert_num = 0; vert_num < mesh.vertices_count; vert_num++) {
                if (vertex_map[vert_num] == -1) {
                    var vert_x_normal = Math.floor(((vertex_values[vert_num][0] - bbox.min[0]) / bbox.size[0]) * max_quant + 0.5);
                    var vert_y_normal = Math.floor(((vertex_values[vert_num][1] - bbox.min[1]) / bbox.size[1]) * max_quant + 0.5);
                    var vert_z_normal = Math.floor(((vertex_values[vert_num][2] - bbox.min[2]) / bbox.size[2]) * max_quant + 0.5);

                    var vert_x = Math.floor(vert_x_normal / dim) * dim;
                    var vert_y = Math.floor(vert_y_normal / dim) * dim;
                    var vert_z = Math.floor(vert_z_normal / dim) * dim;

                    var quant_idx = vert_x + vert_y * dim + vert_z * dim * dim;

                    vertex_quant_idx[vert_num] = quant_idx;
                    vertex_quant[vert_num] = [vert_x_normal, vert_y_normal, vert_z_normal];
                }
            }

            var num_indices = 0;

            for (tri_num = 0; tri_num < mesh.faces_count; tri_num++) {
                if (!valid_tri[tri_num]) {
                    var quant_map = [-1, -1, -1];

                    var is_valid = true;

                    for (vert_idx = 0; vert_idx < 3; vert_idx++) {
                        var curr_quant = vertex_quant_idx[tri[tri_num][vert_idx]];

                        if (curr_quant in quant_map) {
                            is_valid = false;
                            break;
                        } else {
                            quant_map[vert_idx] = curr_quant;
                        }
                    }

                    if (is_valid) {
                        valid_tri[tri_num] = true;

                        for (vert_idx = 0; vert_idx < 3; vert_idx++) {
                            vert_num = tri[tri_num][vert_idx];

                            if (vertex_map[vert_num] == -1) {

                                // Store quantized coordinates
                                for (comp_idx = 0; comp_idx < 3; comp_idx++) {
                                    vert_buf.writeUInt16LE(vertex_quant[vert_num][comp_idx], vert_buf_ptr);
                                    vert_buf_ptr += 2;
                                }

                                // Padding to align with 4 bytes
                                vert_buf.writeUInt16LE(0, vert_buf_ptr);
                                vert_buf_ptr += 2;

                                // Write normals in 8-bit
                                for (comp_idx = 0; comp_idx < 3; comp_idx++) {
                                    var comp = Math.floor((normal_values[vert_num][comp_idx] + 1) * 127 + 0.5);
                                    if (isNaN(comp)) comp = 0;

                                    vert_buf.writeUInt8(comp, vert_buf_ptr);
                                    vert_buf_ptr++;
                                }

                                // Padding to align with 4 bytes
                                vert_buf.writeUInt8(0, vert_buf_ptr);
                                vert_buf_ptr++;

                                if (has_tex) {
                                    /*
                                    var u_coord = tex_coords[vert_num][0];
                                    var v_coord = tex_coords[vert_num][1];

                                    if ((u_coord - (u_coord % 1)) % 2 == 0)
                                    {
                                        u_coord = ((u_coord % 1.0) + 1.0) % 1.0
                                    */

                                    for (comp_idx = 0; comp_idx < 2; comp_idx++) {
                                        var wrap_tex = tex_coords[vert_num][comp_idx];

                                        if (comp_idx == 0) wrap_tex = (wrap_tex - min_texcoordu) / (max_texcoordu - min_texcoordu);
                                        else wrap_tex = (wrap_tex - min_texcoordv) / (max_texcoordv - min_texcoordv);

                                        if (isNaN(wrap_tex)) wrap_tex = 0;

                                        var comp = Math.floor((wrap_tex * 65535) + 0.5);

                                        vert_buf.writeUInt16LE(comp, vert_buf_ptr);
                                        vert_buf_ptr += 2;
                                    }
                                }

                                vertex_map[vert_num] = new_vertex_id;
                                new_vertex_id += 1;
                                added_verts += 1;
                            }
                        }

                        for (vert_idx = 0; vert_idx < 3; vert_idx++) {
                            var vert_num = tri[tri_num][vert_idx];

                            idx_buf.writeUInt16LE(vertex_map[vert_num], idx_buf_ptr);
                            idx_buf_ptr += 2;
                        }

                        num_indices += 3;
                    }
                }
            }

            GLOBAL.pbf_cache[mesh['id']][lod] = {};
            GLOBAL.pbf_cache[mesh['id']][lod].num_idx = num_indices;
            GLOBAL.pbf_cache[mesh['id']][lod].idx_buf = idx_buf.slice(0, idx_buf_ptr);
            GLOBAL.pbf_cache[mesh['id']][lod].vert_buf = vert_buf.slice(0, vert_buf_ptr);
            GLOBAL.pbf_cache[mesh['id']][lod].vert_buf_offset = buf_offset;
            GLOBAL.pbf_cache[mesh['id']][lod].num_vertices = prev_added_verts;
            prev_added_verts = added_verts;
            buf_offset += GLOBAL.pbf_cache[mesh['id']][lod].vert_buf.length;

            lod += 1;

        }

        GLOBAL.pbf_cache[mesh['id']].num_levels = lod;
        logger.log('debug', '#LEVELS : ' + GLOBAL.pbf_cache[mesh['id']].num_levels);
    }
}

function getPopCache(err, db, dbname, get_data, level, mesh_id, callback) {
    if (err) return callback(err, null);

	if (!('pbf_cache' in GLOBAL)) {
        GLOBAL.pbf_cache = {};
        logger.log('debug', 'Created cache');
    }

    var already_have = true;

    if (mesh_id in GLOBAL.pbf_cache) {
        // TODO: Lazy, if a level is not passed in when getting data
        // should only get necessary levels, rather than everything again.
        if (!level && get_data) already_have = false;
        else if (level) {
            if (!(level in GLOBAL.pbf_cache[mesh_id])) already_have = false;
            else already_have = (GLOBAL.pbf_cache[mesh_id][level].has_data == get_data);
        }

        // Do we have an empty object
        if (!Object.keys(GLOBAL.pbf_cache[mesh_id]).length) {
            already_have = false;
        }

    } else {
        GLOBAL.pbf_cache[mesh_id] = {};

        // If we don't have the skeleton, load the skeleton
        if (level) getPopCache(err, db, dbname, false, null, mesh_id, function(err) {});

        already_have = false;
    }

    if (!already_have) {
        db.get_cache(err, dbname, mesh_id, get_data, level, function(err, coll) {
            if (err) return callback(err, null);

            var max_lod = 0;

            for (var idx = 0; idx < coll.length; idx++) {

                var cache_obj = coll[idx];
                if (cache_obj['type'] == 'PopGeometry') {
                    if ('stride' in cache_obj) GLOBAL.pbf_cache[mesh_id].stride = cache_obj['stride'];

                    if ('min_texcoordu' in cache_obj) {
                        GLOBAL.pbf_cache[mesh_id].min_texcoordu = cache_obj['min_texcoordu'];
                        GLOBAL.pbf_cache[mesh_id].max_texcoordu = cache_obj['max_texcoordu'];
                        GLOBAL.pbf_cache[mesh_id].min_texcoordv = cache_obj['min_texcoordv'];
                        GLOBAL.pbf_cache[mesh_id].max_texcoordv = cache_obj['max_texcoordv'];
                        GLOBAL.pbf_cache[mesh_id].has_tex = true;
                    }
                } else if (cache_obj['type'] == 'PopGeometryLevel') {
                    var lod = cache_obj['level'];
                    GLOBAL.pbf_cache[mesh_id][lod] = {};
                    GLOBAL.pbf_cache[mesh_id][lod].num_idx = cache_obj['num_idx'];
                    GLOBAL.pbf_cache[mesh_id][lod].vert_buf_offset = cache_obj['vert_buf_offset'];
                    GLOBAL.pbf_cache[mesh_id][lod].num_vertices = cache_obj['num_vertices'];

                    GLOBAL.pbf_cache[mesh_id][lod].has_data = get_data;

                    if (get_data) {
                        GLOBAL.pbf_cache[mesh_id][lod].idx_buf = cache_obj['idx_buf'];
                        GLOBAL.pbf_cache[mesh_id][lod].vert_buf = cache_obj['vert_buf'];
                    }

                    if (lod > max_lod) max_lod = lod;
                }
            }

			if (!level)
				GLOBAL.pbf_cache[mesh_id].num_levels = max_lod + 1;

			callback(null);
        });
    } else {
		callback(null);
	}
}

function getChild(parent, type, n) {
    if ((parent == null) || !('children' in parent)) {
        return null;
    }

    var type_idx = 0;

    n = typeof n !== 'undefined' ? n : 0;

    for (var child_idx = 0; child_idx < parent.children.length; child_idx++) {
        if (parent.children[child_idx]['type'] == type) {
            if (type_idx == n) {
                return parent.children[child_idx];
            }

            type_idx++;
        }
    }

    return null;

}

function getMaterial(mesh, n) {
    return getChild(mesh, 'material');
}

function getTexture(mat, n) {
    return getChild(mat, 'texture');
}

function X3D_Header() {
    var xml_doc = new dom_imp().createDocument('http://www.web3d.org/specification/x3d-namespace', 'X3D');

    xml_doc.firstChild.setAttribute('xmlns', 'http://www.web3d.org/specification/x3d-namespace');

    return xml_doc;
}

function X3D_CreateScene(xml_doc) {
    var scene = xml_doc.createElement('Scene');
	scene.setAttribute('id', 'scene');

    var head = xml_doc.createElement('navigationInfo');

    head.setAttribute('DEF', 'head');
    head.setAttribute('headlight', 'true');
    head.setAttribute('type', 'EXAMINE');

    head.textContent = ' ';

    //scene.appendChild(head);
    xml_doc.firstChild.appendChild(scene);

    // Background color (ie skybox)
    var bground = xml_doc.createElement('background');
    bground.setAttribute('skyangle', '0.9 1.5 1.57');
    bground.setAttribute('skycolor', '0.21 0.18 0.66 0.2 0.44 0.85 0.51 0.81 0.95 0.83 0.93 1');
    bground.setAttribute('groundangle', '0.9 1.5 1.57');
    bground.setAttribute('groundcolor', '0.65 0.65 0.65 0.73 0.73 0.73 0.81 0.81 0.81 0.91 0.91 0.91');
	bground.textContent = ' ';
    scene.appendChild(bground);

/*
    var fog = xml_doc.createElement('fog');
    fog.setAttribute('visibilityRange', '300');
    fog.setAttribute('color', '1,1,1');
    fog.setAttribute('fogType', 'LINEAR');
    fog.textContent = ' ';
    scene.appendChild(fog);
  */

    // Environmental variables
    var environ = xml_doc.createElement('environment');
    environ.setAttribute('frustumCulling', 'true');
    environ.setAttribute('smallFeatureCulling', 'true');
    environ.setAttribute('smallFeatureThreshold', 5);
    environ.setAttribute('occlusionCulling', 'true');
    environ.textContent = ' ';

    scene.appendChild(environ);

	return scene;
}

function X3D_AddChildren(xml_doc, xml_node, node, db_interface, account, project, mode)
{
	if (!('children' in node))
		return;

	for(var ch_idx = 0; ch_idx < node['children'].length; ch_idx++)
	{
		var child = node['children'][ch_idx];
		var new_node = null;

		if (child['type'] == 'ref')
		{
			new_node = xml_doc.createElement('Inline');

			var url_str = child['project'] + "." + mode + ".x3d";

			if ('revision' in child)
				var url_str = '/' + account + '/' + child['project'] + '/revision/master/' + child['revision'] + '.x3d.' + mode;
			else
				var url_str = '/' + account + '/' + child['project'] + '/revision/master/head.x3d.' + mode;

			new_node.setAttribute('url', url_str);
			new_node.setAttribute('id', child['id']);
			new_node.setAttribute('DEF', db_interface.uuidToString(child["shared_id"]));
			new_node.setAttribute('nameSpaceName', child['project']);

			xml_node.appendChild(new_node);

			X3D_AddChildren(xml_doc, new_node, child, db_interface, account, project, mode);
		}
		else if (child['type'] == 'transformation')
		{
			var mat_str = "";
			for(var mat_col = 0; mat_col < 4; mat_col++)
			{
				for(var mat_row = 0; mat_row < 4; mat_row++)
				{
					mat_str += child['matrix'][mat_row][mat_col];

					if (!((mat_row == 3) && (mat_col == 3)))
						mat_str += ',';
				}
			}

			if (mat_str == "1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1")
			{
				new_node = xml_doc.createElement('Group');
			} else {
				new_node = xml_doc.createElement('MatrixTransform');
				new_node.setAttribute('matrix', mat_str);
			}

			new_node.setAttribute("id", child['id']);
			new_node.setAttribute('DEF', db_interface.uuidToString(child["shared_id"]));
			xml_node.appendChild(new_node);
			X3D_AddChildren(xml_doc, new_node, child, db_interface, account, project, mode);
		} else if(child['type'] == 'material') {
			 var appearance = xml_doc.createElement('Appearance');


				if (!child['two_sided']) {
					new_node = xml_doc.createElement('Material');
				} else {
					new_node = xml_doc.createElement('TwoSidedMaterial');
				}


				//new_node = xml_doc.createElement('TwoSidedMaterial');

				var ambient_intensity = 1;

				if (('ambient' in child) && ('diffuse' in child)) {
					for (var i = 0; i < 3; i++) {
						if (child['diffuse'][i] != 0) {
							ambient_intensity = child['ambient'][i] / child['diffuse'][i];
							break;
						}
					}
				}

				//new_node.setAttribute('DEF', child['_id']);

				if ('diffuse' in child) new_node.setAttribute('diffuseColor', child['diffuse'].join(' '));

				if ('shininess' in child) new_node.setAttribute('shininess',  child['shininess'] / 512);

				if ('specular' in child) new_node.setAttribute('specularColor', child['specular'].join(' '));

				if ('opacity' in child) {
					if (child['opacity'] != 1) {
						new_node.setAttribute('transparency', 1.0 - child['opacity']);
					}
				}

				new_node.textContent = ' ';
				new_node.setAttribute("id", child['id']);
				new_node.setAttribute('DEF', db_interface.uuidToString(child["shared_id"]));
				appearance.appendChild(new_node);
				xml_node.appendChild(appearance);
				X3D_AddChildren(xml_doc, appearance, child, db_interface, account, project, mode);
		} else if (child['type'] == 'texture') {
            new_node = xml_doc.createElement('ImageTexture');
            new_node.setAttribute('url', '/' + account + '/' + project + '/' + child['id'] + '.' + child['extension']);
            new_node.textContent = ' ';
			new_node.setAttribute("id", child['id']);
			new_node.setAttribute('DEF', db_interface.uuidToString(child["shared_id"]));
			xml_node.appendChild(new_node);
			X3D_AddChildren(xml_doc, new_node, child, db_interface, account, project, mode);
		} else if (child['type'] == 'mesh') {
			var shape = xml_doc.createElement('Shape');
			shape.setAttribute('id', child['id']);
			shape.setAttribute('DEF', db_interface.uuidToString(child["shared_id"]));
			shape.setAttribute('onclick', 'clickObject(event);');
			shape.setAttribute('onmouseover', 'onMouseOver(event);');
			shape.setAttribute('onmousemove', 'onMouseMove(event);');
			X3D_AddChildren(xml_doc, shape, child, db_interface, account, project, mode);

			X3D_AddToShape(xml_doc, shape, db_interface, account, project, child, mode);
			xml_node.appendChild(shape);
		}
	}
}

function X3D_AddToShape(xml_doc, shape, db_interface, account, project, mesh, mode) {
    var mesh_id = mesh['id'];
    var mat = getMaterial(mesh, 0);

    logger.log('debug', 'Loading mesh ' + mesh_id);

    var bbox = repoNodeMesh.extractBoundingBox(mesh);

    switch (mode) {
    case "x3d":
        shape.setAttribute('bboxCenter', bbox.center.join(' '));
        shape.setAttribute('bboxSize', bbox.size.join(' '));

        var indexedfaces = xml_doc.createElement('IndexedFaceSet');

        indexedfaces.setAttribute('ccw', 'false');
        indexedfaces.setAttribute('solid', 'false');
        indexedfaces.setAttribute('creaseAngle', '3.14');

        var face_arr = '';
        var idx = 0;

        for (var face_idx = 0; face_idx < mesh.mFaces.length; face_idx++) {
            for (var vert_idx = 0; vert_idx < mesh.mFaces[face_idx].length; vert_idx++) {
                face_arr += mesh.mFaces[face_idx][vert_idx] + ' ';
            }
            face_arr += '-1 ';

        }
        indexedfaces.setAttribute('coordIndex', face_arr);
        shape.appendChild(indexedfaces);

        var coordinate = xml_doc.createElement('Coordinate');
        var coord_arr = '';

        for (var vert_idx = 0; vert_idx < mesh.mVertices.length; vert_idx++) {
            for (var comp_idx = 0; comp_idx < 3; comp_idx++) {
                coord_arr += mesh.mVertices[comp_idx] + ' ';
            }
        }

        coordinate.setAttribute('point', coord_arr);
        indexedfaces.appendChild(coordinate);

        break;

    case "src":
        shape.setAttribute('bboxCenter', bbox.center.join(' '));
        shape.setAttribute('bboxSize', bbox.size.join(' '));

        var externalGeometry = xml_doc.createElement('ExternalGeometry');

		//externalGeometry.setAttribute('solid', 'true');

        if ('children' in mat) {
            var tex_id = mat['children'][0]['id'];
            externalGeometry.setAttribute('url', '/' + account + '/' + project + '/' + mesh_id + '.src?tex_uuid=' + tex_id);
        } else {
            externalGeometry.setAttribute('url', '/' + account + '/' + project + '/' + mesh_id + '.src');
        }

        //externalGeometry.setAttribute('url', '../x3dom_example/src0.src');
        shape.appendChild(externalGeometry);
        break;

    case "bin":
        shape.setAttribute('bboxCenter', bbox.center.join(' '));
        shape.setAttribute('bboxSize', bbox.size.join(' '));

        var binaryGeometry = xml_doc.createElement('binaryGeometry');

        binaryGeometry.setAttribute('normal', '/' + account + '/' + project + '/' + mesh_id + '.bin?mode=normals');

        if ('children' in mat) {
            binaryGeometry.setAttribute('texCoord', '/' + account + '/' + project + '/' + mesh_id + '.bin?mode=texcoords');
        }

        binaryGeometry.setAttribute('index', '/' + account + '/' + project + '/' + mesh_id + '.bin?mode=indices');
        binaryGeometry.setAttribute('coord', '/' + account + '/' + project + '/' + mesh_id + '.bin?mode=coords');
        //binaryGeometry.setAttribute('vertexCount', mesh.vertices_count);
        binaryGeometry.textContent = ' ';

        shape.appendChild(binaryGeometry);
        break;


    case "pbf":
        var pop_geometry = xml_doc.createElement('PopGeometry');

        //genPopCache(mesh);

        getPopCache(null, db_interface, project, false, null, mesh['id'], function(err) {
            if (mesh['id'] in GLOBAL.pbf_cache) {
                var cache_mesh = GLOBAL.pbf_cache[mesh['id']];

				pop_geometry.setAttribute('id', 'tst');
                pop_geometry.setAttribute('vertexCount', mesh.faces_count * 3);
                pop_geometry.setAttribute('vertexBufferSize', mesh.vertices_count);
                pop_geometry.setAttribute('primType', "TRIANGLES");
                pop_geometry.setAttribute('attributeStride', cache_mesh.stride);
                pop_geometry.setAttribute('normalOffset', 8);
                pop_geometry.setAttribute('bbMin', bbox.min.join(' '));

                if (cache_mesh.has_tex) {
                    pop_geometry.setAttribute('texcoordOffset', 12);
                }

                pop_geometry.setAttribute('size', bbox.size.join(' '));
                pop_geometry.setAttribute('tightSize', bbox.size.join(' '));
                pop_geometry.setAttribute('maxBBSize', bbox.size.join(' '));

                if ('min_texcoordu' in cache_mesh) {
                    pop_geometry.setAttribute('texcoordMinU', cache_mesh.min_texcoordu);
                    pop_geometry.setAttribute('texcoordScaleU', (cache_mesh.max_texcoordu - cache_mesh.min_texcoordu));
                    pop_geometry.setAttribute('texcoordMinV', cache_mesh.min_texcoordv);
                    pop_geometry.setAttribute('texcoordScaleV', (cache_mesh.max_texcoordv - cache_mesh.min_texcoordv));
                }

                for (var lvl = 0; lvl < cache_mesh.num_levels; lvl++) {
                    var pop_geometry_level = xml_doc.createElement('PopGeometryLevel');

                    pop_geometry_level.setAttribute('src', '/' + account + '/' + project + '/' + mesh_id + '.pbf?level=' + lvl);
                    pop_geometry_level.setAttribute('numIndices', cache_mesh[lvl].num_idx);
                    pop_geometry_level.setAttribute('vertexDataBufferOffset', cache_mesh[lvl].num_vertices);

                    pop_geometry_level.textContent = ' ';
                    pop_geometry.appendChild(pop_geometry_level);
                }

                shape.appendChild(pop_geometry);

                shape.setAttribute('bboxCenter', bbox.center.join(' '));
                shape.setAttribute('bboxSize', bbox.size.join(' '));
            }
        });

        break;
    }
};

function X3D_AddLights(xml_doc, bbox)
{
	var scene = xml_doc.getElementsByTagName('Scene')[0];

	var p_light = xml_doc.createElement('PointLight');
	p_light.setAttribute('ambientIntensity', '0.8');
	p_light.setAttribute('location', bbox.max.join(' '));
	p_light.setAttribute('shadowIntensity', 0.7);
	p_light.textContent = ' ';

	scene.appendChild(p_light);
};

function X3D_AddMeasurer(xml_doc) {
	var scene = xml_doc.getElementsByTagName('Scene')[0];

	var trans = xml_doc.createElement('Transform');
	trans.setAttribute('id', 'lineTrans');
	trans.setAttribute('ng-controller', "MeasurerCtrl");
	trans.setAttribute('render', '{{render()}}');

	var shape = xml_doc.createElement('Shape');
	shape.setAttribute('isPickable', 'false');

	var app = xml_doc.createElement('Appearance');
	var mat = xml_doc.createElement('Material');
	mat.setAttribute('emissiveColor', '1 0 0');

	var dm = xml_doc.createElement('DepthMode');
	dm.setAttribute('enableDepthTest', 'false');

	var lp = xml_doc.createElement('LineProperties');
	lp.setAttribute('linewidthScaleFactor', 10);

	app.appendChild(mat);
	app.appendChild(dm);
	app.appendChild(lp);

	var ils = xml_doc.createElement('IndexedLineSet');
	ils.setAttribute('coordIndex', '0 1 0 -1');

	var coord = xml_doc.createElement('Coordinate');
	coord.setAttribute('id', 'line');
	coord.setAttribute('point', '{{pointString()}}');

	ils.appendChild(coord);

	shape.appendChild(app);
	shape.appendChild(ils);

	trans.appendChild(shape);

	scene.appendChild(trans);
};

function X3D_AddViewpoint(xml_doc, bbox)
{
    var scene = xml_doc.getElementsByTagName('Scene')[0];
	var vpos = [0,0,0];

	vpos[0] = bbox.center[0];
	vpos[1] = bbox.center[1];
	vpos[2] = bbox.center[2];

	var max_dim = Math.max(bbox.size[0], bbox.size[1]) * 0.5;

	var fov = 40 * (Math.PI / 180); // Field of view in radians

	vpos[2] += bbox.size[2] * 0.5 + max_dim / Math.tan(0.5 * fov);

	logger.log('debug', 'VPOS: ' + vpos.join(' '));
	logger.log('debug', 'MAXDIM: ' + max_dim);

    var vpoint = xml_doc.createElement('Viewpoint');
    vpoint.setAttribute('id', 'sceneVP');
    vpoint.setAttribute('position', vpos.join(' '));
    vpoint.setAttribute('orientation', '0 0 -1 0');
    vpoint.setAttribute('zNear', 0.01);

    vpoint.setAttribute('zFar', 10000);
	vpoint.setAttribute('fieldOfView', fov);

    vpoint.textContent = ' ';

    scene.appendChild(vpoint);
}

function X3D_AddGroundPlane(xml_doc, bbox)
{
	var scene = xml_doc.getElementsByTagName('Scene')[0];

	var flipMat = xml_doc.createElement('Transform');

	flipMat.setAttribute("rotation", "1,0,0,4.7124");
	flipMat.setAttribute("center", bbox.center.join(','));

	var planeShape = xml_doc.createElement('Shape');
	planeShape.setAttribute("id", "dontBother");
	var groundPlane = xml_doc.createElement('Plane');

	groundPlane.setAttribute('center', bbox.center.join(','));
	groundPlane.setAttribute("lit", "false");
	var bboxsz = [0,0];
	bboxsz[0] = bbox.size[0] * 5;
	bboxsz[1] = bbox.size[1] * 5;

	groundPlane.setAttribute('size', bboxsz.join(','));

	var mat = xml_doc.createElement('Material');

	mat.setAttribute('emissiveColor', '0.3333 0.7373 0.3137');
	mat.textContent = ' ';

	var appearance = xml_doc.createElement('Appearance');
	appearance.appendChild(mat);

	groundPlane.textContent = " ";

	planeShape.appendChild(appearance);
	planeShape.appendChild(groundPlane);
	flipMat.appendChild(planeShape);
	scene.appendChild(flipMat);
}

function render(db_interface, account, project, sub_format, revision, res, err_callback) {
    db_interface.getScene(null, project, revision, function(err, doc) {
		var xml_doc = X3D_Header();
		var scene = X3D_CreateScene(xml_doc);

		// Hack for the demo, generate objects server side
		json_objs = [];

		var scene_bbox_min = [];
		var scene_bbox_max = [];

		var dummyRoot = { children: [doc.mRootNode] };

		X3D_AddChildren(xml_doc, scene, dummyRoot, db_interface, account, project, sub_format);

		// Compute the scene bounding box.
		// Should be a better way of doing this.
		for (var mesh_id in doc['meshes']) {
			var mesh = doc['meshes'][mesh_id];
			var bbox = repoNodeMesh.extractBoundingBox(mesh);

			if (scene_bbox_min.length)
			{
				for(var idx = 0; idx < 3; idx++)
				{
					scene_bbox_min[idx] = Math.min(scene_bbox_min[idx], bbox.min[idx]);
					scene_bbox_max[idx] = Math.max(scene_bbox_max[idx], bbox.max[idx]);
				}
			} else {
				scene_bbox_min = bbox.min.slice(0);
				scene_bbox_max = bbox.max.slice(0);
			}
		}

		var bbox = {};
		bbox.min = scene_bbox_min;
		bbox.max = scene_bbox_max;
		bbox.center = [0.5 * (bbox.min[0] + bbox.max[0]), 0.5 * (bbox.min[1] + bbox.max[1]), 0.5 * (bbox.min[2] + bbox.max[2])];
		bbox.size = [(bbox.max[0] - bbox.min[0]), (bbox.max[1] - bbox.min[1]), (bbox.max[2] - bbox.min[2])];

		//X3D_AddGroundPlane(xml_doc, bbox);
		//X3D_AddViewpoint(xml_doc, bbox);
		//X3D_AddLights(xml_doc, bbox);

		var xml_str = new xml_serial().serializeToString(xml_doc);
		res.write(xml_str);

		res.end();
    });
};

exports.route = function(router)
{
	router.get('x3d', '/:account/:project/revision/:rid', function(res, params)
	{
		render(router.db_interface, params.account, params.project,  params.subformat, params.rid, res,
			function(err) {
				throw err;
			});
	});

	router.get('x3d', '/:account/:project/revision/:branch/head', function(res, params)
	{
		render(router.db_interface, params.account, params.project, params.subformat, null, res,
			function(err) {
				throw err;
			});
	});

	router.get('x3d', '/:account/:project/revision/:rid/:sid', function(res, params)
	{
	    render(router.db_interface, params.account, params.project, params.subformat, params.rid, res,
			function(err) {
				throw err;
		});
	});

	router.get('x3d', '/:account/:project/revision/:branch/head/:sid', function(res, params)
	{
		render(router.db_interface, params.account, params.project, params.subformat, null, res,
			function(err) {
				throw err;
		});
	});
}
