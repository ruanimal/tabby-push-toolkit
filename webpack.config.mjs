import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { builtinModules } from 'node:module'
import { AngularWebpackPlugin } from '@ngtools/webpack'
import { createEs2015LinkerPlugin } from '@angular/compiler-cli/linker/babel'
const root = path.dirname(fileURLToPath(import.meta.url))
export default {
    target: 'node',
    entry: './src/index.ts',
    devtool: 'source-map',
    cache: false,
    output: {
        path: path.join(root, 'dist'),
        filename: 'index.js',
        libraryTarget: 'umd',
        globalObject: 'this',
    },
    resolve: { extensions: ['.ts', '.js'] },
    externals: [
        /^@angular\//,
        /^@ng-bootstrap\//,
        /^@electron\/remote$/,
        /^rxjs/,
        /^tabby-/,
        ...builtinModules,
        /^node:/,
    ],
    module: {
        rules: [
            {
                test: /\.m?js$/,
                loader: 'babel-loader',
                options: {
                    plugins: [
                        createEs2015LinkerPlugin({
                            linkerJitMode: true,
                            fileSystem: {
                                resolve: path.resolve,
                                exists: fs.existsSync,
                                dirname: path.dirname,
                                relative: path.relative,
                                readFile: fs.readFileSync,
                            },
                        }),
                    ],
                },
                resolve: { fullySpecified: false },
            },
            { test: /\.ts$/, loader: '@ngtools/webpack' },
            { test: /\.sh$/, type: 'asset/source' },
        ],
    },
    plugins: [
        new AngularWebpackPlugin({ tsconfig: path.join(root, 'tsconfig.json'), jitMode: true }),
    ],
}
