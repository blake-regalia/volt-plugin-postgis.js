
// native imports
import path from 'path';
import util from 'util';

// gulp
import gulp from 'gulp';

// load gulp plugins
import plugins from 'gulp-load-plugins';
const $ = plugins({
	// // uncomment these lines to show debug messages while loading gulp plugins
	// DEBUG: true,

	// load gulp and vinyl modules
	pattern: ['gulp-*', 'vinyl-*'],
	replaceString: /^(?:gulp|vinyl)(-|\.)/,
});

// third party
import del from 'del';
import {Instrumenter} from 'isparta';

// compile config
import config from './gulp-config.json';


// pre-test
gulp.task('pre-test', () => {
	return gulp.src('lib/**/*.js')
		.pipe($.istanbul({
			includeUntested: true,
			instrumenter: Instrumenter
		}))
		.pipe($.istanbul.hookRequire());
});

// test
gulp.task('test', ['pre-test', 'test-basic']);

// coveralls
gulp.task('coveralls', ['test'], () => {
	if (!process.env.CI) {
		return;
	}
	return gulp.src(path.join(__dirname, 'coverage/lcov.info'))
		.pipe($.coveralls());
});

//
const H_DELEGATORS = {
	clean(s_dir, s_task) {
		gulp.task(s_task, () => {
			return del.sync([
				path.join(config.dest, s_dir)
			]);
		});
	},

	build(s_dir, s_task) {
		gulp.task(s_task, [`clean-${s_dir}`], () => {

			// load all javascript source files
			return gulp.src(path.join(config.src, s_dir)+'/*.js')

				// handle uncaught exceptions thrown by any of the plugins that follow
				.pipe($.plumber())

				// do not recompile unchanged files
				.pipe($.cached(`build-${s_dir}`))

				// lint all javascript source files
				.pipe($.eslint())
				.pipe($.eslint.format())

				// preserve mappings to source files for debugging
				.pipe($.sourcemaps.init())

					// transpile
					.pipe($.babel())
				.pipe($.sourcemaps.write())

				// write output to dist directory
				.pipe(gulp.dest(path.join(config.dest, s_dir)));
		});
	},

	debug(s_dir, s_task) {
		gulp.task(s_task, [`build-${s_dir}`], () => {

			// load javascript source files
			return gulp.src(path.join(config.src, s_dir)+'/*.js')

				// 
				.pipe($.nodeInspector({
					preload: false,
					debugBrk: true,
				}));
		});
	},

	develop(s_dir, s_task) {
		gulp.task(s_task, [`build-${s_dir}`], () => {
			gulp.watch(path.join(config.src, s_dir)+'/*.js', [`build-${s_dir}`]);
		});
	},
};


//
const H_GENERATORS = {

	// transpiling javascript source to distribution
	transpile: ['clean', 'build', 'debug', 'develop'],
};


// prep hash of task lists
let h_task_lists = {};

//
Object.keys(config.tasks).forEach((s_directive) => {
	config.tasks[s_directive].forEach((s_dir) => {

		// each delegate
		H_GENERATORS[s_directive].forEach((z_delegate) => {

			// 
			if('string' === typeof z_delegate) {
				// create task name
				let s_task = `${z_delegate}-${s_dir}`;

				// forward task details to delegator
				H_DELEGATORS[z_delegate](s_dir, s_task);

				// ref corresponding task list
				let a_task_list = h_task_lists[z_delegate];

				// corresponding task list does not yet exist; create it
				if(!a_task_list) {
					a_task_list = h_task_lists[z_delegate] = [];
				}

				// append task name to its corresponding task list
				a_task_list.push(s_task);
			}
		});
	});
});

// make tasks lists
for(let s_general_task in h_task_lists) {
	gulp.task(s_general_task, h_task_lists[s_general_task]);
}


// default
gulp.task('default', ['build']);

