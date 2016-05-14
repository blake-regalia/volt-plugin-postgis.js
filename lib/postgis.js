
// native imports
import os from 'os';

// third-party modules
import pg from 'pg-native';
import which from 'which';

// local classes


/**
* defaults:
**/

// is libpq installed?
const B_HAS_LIBPQ = (() => {
	let b_has_libpq = true;
	try {
		which.sync('pg_config');
	}
	catch(e) {
		b_has_libpq = false;
	}
	return b_has_libpq;
})();

// non-libpq systems not yet supported
if(!B_HAS_LIBPQ) throw 'system does not have libpq installed, non-libpq systems are not yet supported';

//
const N_MAX_COLUMN_WIDTH = 1663;

// number of cpus
const N_CPU_COUNT = os.cpus().length;


/**
* private static:
**/

const serialize_chunk = (a_chunk) => {
	return a_chunk.map((h_selection, i_fragment) => {
		// build select expression
		return `${h_selection.expression} as r${i_fragment}`;
	}).join(',');
};


class psql {

	constructor(h_psql_config) {

		// destruct config
		let {
			connection: s_connection,
		} = h_psql_config;

		// instantiate client
		let y_client = new pg();

		// default
		Object.assign(this, {
			psql_config: h_psql_config,
			queries: [],
			client: y_client,
			connected: false,
		});

		// open connection
		y_client.connect(s_connection, (e_connect) => {
			if(e_connect) throw e_connect;

			// now, the client is connected
			this.connected = true;

			// process queries in queue
			this.next_query();
		});
	}

	// process next query in queue
	next_query() {

		// destruct members
		let {
			queries: a_queries,
			client: y_client,
		} = this;

		// no queries to process
		if(!a_queries.length) return;

		// take first query
		let h_query = a_queries.shift();

		// execute
		y_client.query(h_query.sql, (e_query, a_rows) => {
			if(e_query) throw e_query;

			// callback results
			h_query.rows(a_rows);

			// continue processing
			this.next_query();
		});
	}

	// add query to queue
	query(s_sql, f_rows) {

		// destruct members
		let {
			queries: a_queries,
			connected: b_client_connected,
		} = this;

		// push query to end of queue
		a_queries.push({
			sql: s_sql,
			rows: f_rows,
		});

		// queue is not busy, start processing
		if(1 === a_queries.length && b_client_connected) {
			this.next_query();
		}
	}
}


class psql_pool {

	constructor(h_psql_config, n_max_clients) {

		//
		Object.assign(this, {
			psql_config: h_psql_config,
			max_clients: n_max_clients,
			clients: [],
			selections: [],
			accumulating: false,
		});

		// create first client
		this.add_client();
	}

	// add new client to pool
	add_client() {

		// create new client
		let k_client = new psql(this.psql_config);

		// push to back of list
		this.clients.push(k_client);

		//
		return k_client;
	}

	// fetch the least busy client
	get least_busy() {

		// destruct members
		let {
			clients: a_clients,
			max_clients: n_max_clients,
		} = this;

		// not at capacity yet
		if(a_clients.length < n_max_clients) {
			// create new client; problem solved
			return this.add_client();
		}

		// fetch list of query loads from clients
		let a_query_loads = a_clients.map((k_client) => {
			return k_client.queries.length;
		});

		// find index of min query
		let i_least_busy = a_query_loads.reduceRight((a_min, n_queries, i_client) => {
			if(n_queries === Math.min(a_min[1], n_queries)) {
				return [i_client, n_queries];
			}
			return a_min;
		}, [-1, Infinity])[0];

		// return least busy client using index
		return a_clients[i_least_busy];
	}

	// evaluate the sql expression
	eval(s_sql_expression, f_okay) {

		// destruct members
		let {
			selections: a_selections,
			accumulating: b_accumulating,
		} = this;

		// add expression to selection list
		a_selections.push({
			expression: s_sql_expression,
			result: f_okay,
		});

		// not accumulating yet
		if(!b_accumulating) {

			// now we are accumulating
			b_accumulating = true;

			// queue for next event loop behind io operations
			setImmediate(this.drain.bind(this));
		}
	}

	// drain the queue by querying among clients in the pool
	drain() {
		// destruct members
		let {
			selections: a_selections,
			max_clients: n_max_clients,
		} = this;

		// single selection
		if(1 === a_selections.length) {
			// take selection
			let h_selection = a_selections.pop();

			// forward to least busy client
			this.least_busy.query(`select ${h_selection.expression} as r`, (a_rows) => {

				// pass result back to callee
				h_selection.result(a_rows[0].r);
			});
		}
		// multiple selections
		else {
			// split selection args by max clients
			let n_chunk_size = Math.ceil(a_selections.length / n_max_clients);

			// prep to loop through all clients
			let i_client = 0;

			// while there are chunks to split
			while(a_selections.length) {
				// take a chunk
				let a_chunk = a_selections.splice(0, n_chunk_size);

				// pass to next client
				this.batch(a_chunk, i_client++);
			}
		}
	}

	// process a chunk of query selections in batch
	batch(a_list, i_client) {

		// destruct members
		let {
			clients: a_clients,
		} = this;

		// prep list of chunks
		let a_chunks = [];

		// prep sql statement
		let s_sql;

		// number of selections exceed maximum postgres column width
		if(a_list.length > N_MAX_COLUMN_WIDTH) {
			// prep size of chunks in order to minimize number of dummy columns
			let n_chunk_size = Math.ceil(a_list.length / Math.ceil(a_list.length / (N_MAX_COLUMN_WIDTH - 1)));

			// prep list of query parts to be union'ed
			let a_parts = [];

			// whlie there are chunks to serialize
			while(a_list.length) {
				// make chunk from list
				let a_chunk = a_list.splice(0, n_chunk_size);

				// chunk is not big enough; backfill
				while(a_chunk.length < n_chunk_size) {
					a_chunk.push({
						expression: '1',
					});
				}

				// build selection string
				let s_selections = serialize_chunk(a_chunk);

				// push chunk to list
				a_chunks.push(a_chunk);

				// push query part
				a_parts.push(`select ${s_selections}`);
			}

			// finalize whole selection
			s_sql = `select (${a_parts.join(') union all (')})`;
		}
		// single row query
		else {
			// push 'chunk' to list
			a_chunks.push(a_list);

			// build selection string
			s_sql = `select ${serialize_chunk(a_list)}`;
		}

		// not operating at capacity
		while(i_client >= a_clients.length) {
			// spin up new client
			this.add_client();
		}

		debugger;

		// execute query on given client
		a_clients[i_client].query(s_sql, (a_rows) => {

			// expected 1 row
			if(!a_rows.length) {
				throw 'received empty result list';
			}

			// redistribute results to each callback
			a_rows.forEach((h_row, i_row) => {

				// each column in result row
				for(let s_result in h_row) {
					// parse result index
					let i_result = ~~s_result.substr(1);

					// make callback
					let h_fragment = a_chunks[i_row][i_result];

					// not a dummy fragment; callback
					if(h_fragment.result) h_fragment.result(h_row);
				}
			});
		});
	}
}



/**
* globals;
**/

//
const P_XSD = 'http://www.w3.org/2001/XMLSchema#';


// input argument datatypes
const geography = (h_wkt) => {
	return `ST_GeogFromText('${h_wkt.value.replace(/'/g, '')}')`;
};


// output value datatypes
const xsd = {
	float(s_float) {
		return {
			type: 'literal',
			value: s_float,
			datatpye: P_XSD+'float',
		};
	}
};


// create method handler
const handler = (k_pool, h_methods) => {
	let h_interface = {};

	// each method in hash
	Object.keys(h_methods).forEach((s_name) => {

		// ref method
		let h_method = h_methods[s_name];

		// create interface function
		h_interface[s_name] = (f_resolve, ...a_literals) => {

			// remap literals onto expected argument types
			let a_remapped_arguments = a_literals.map((h_literal, i_literal) => {
				return h_method.arguments[i_literal](h_literal);
			});

			// forward evaluation requet to pool
			return k_pool.eval(`${h_method.function}(${
				a_remapped_arguments.join(',')
			})`, f_resolve);
		};
	});

	//
	return h_interface;
};


/**
* class:
**/
export default {
	namespace: 'http://postgis.net/function/',

	// host config
	creator: function(h_host_config) {

		// fetch database connection string
		let s_db_connection = h_host_config.connection;

		// no database connection string
		if(!s_db_connection) {
			throw 'must provide (database connection string';
		}

		// construct psql config hash
		let h_psql_config = {
			connection: s_db_connection,
		};

		// instance creator
		return function(h_user_config, log) {

			// create pool of psql clients
			let k_pool = new psql_pool(h_psql_config, N_CPU_COUNT);

			//
			return handler(k_pool, {
				azimuth: {
					function: 'ST_Azimuth',
					arguments: [geography, geography],
					datatype: xsd.float,
				},
			});
		};
	},
};
