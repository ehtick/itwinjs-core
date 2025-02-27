/*---------------------------------------------------------------------------------------------
* Copyright (c) Bentley Systems, Incorporated. All rights reserved.
* See LICENSE.md in the project root for license terms and full copyright notice.
*--------------------------------------------------------------------------------------------*/
package com.bentley.imodeljs_test_app

import android.app.Activity
import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.content.res.AssetManager
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import androidx.activity.result.contract.ActivityResultContract
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import com.bentley.itwin.IModelJsHost
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.net.URLConnection
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * Determines the display name for the uri.
 * @param uri The input content Uri.
 * @return The display name or null if it wasn't found.
 */
fun ContentResolver.getFileDisplayName(uri: Uri): String? {
    // Query the content resolver only if we have a content Uri
    return uri.takeIf { uri.scheme == ContentResolver.SCHEME_CONTENT }?.let {
        query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null, null)?.use { cursor ->
            cursor.takeIf { cursor.moveToFirst() }?.getString(0)
        }
    }
}

/**
 * Copies the input uri to the destination directory.
 * @param uri The input content Uri to copy.
 * @param destDir The destination directory.
 * @return The full path of the copied file, null if it failed.
 */
fun Context.copyToExternalFiles(uri: Uri, destDir: String): String? {
    return contentResolver.getFileDisplayName(uri)?.let { displayName ->
        getExternalFilesDir(null)?.let { filesDir ->
            contentResolver.openInputStream(uri)?.use { input ->
                val outDir = File(filesDir.path, destDir)
                outDir.mkdirs()
                val outputFile = File(outDir, displayName)
                outputFile.outputStream().use {
                    input.copyTo(it)
                }
                outputFile.path
            }
        }
    }
}

fun JSONObject.optStringNotEmpty(name: String): String? {
    return optString(name).takeIf { it.isNotEmpty() }
}

typealias PickUriContractType = ActivityResultContract<Nothing?, Uri?>

class PickUriContract(private val destDir: String) : PickUriContractType() {
    private lateinit var context: Context

    override fun createIntent(context: Context, input: Nothing?): Intent {
        this.context = context
        return Intent()
            .setAction(Intent.ACTION_OPEN_DOCUMENT)
            .setType("*/*")
            .addCategory(Intent.CATEGORY_OPENABLE)
    }

    override fun parseResult(resultCode: Int, intent: Intent?): Uri? {
        val uri = intent?.takeIf { resultCode == Activity.RESULT_OK }?.data
        if (uri != null) {
            context.copyToExternalFiles(uri, destDir)?.let { result ->
                return Uri.parse(result)
            }
        }
        return uri
    }
}

// Very similar to WebViewAssetLoader.AssetsPathHandler except it doesn't log an error when a resource isn't found, also doesn't handle SvgZ streams.
class AssetsPathHandler(context: Context) : WebViewAssetLoader.PathHandler {
    private val mContext = context

    private fun removeLeadingSlash(path: String): String {
        return if (path.startsWith('/')) path.substring(1) else path
    }

    private fun openAsset(path: String): InputStream {
        return mContext.assets.open(removeLeadingSlash(path), AssetManager.ACCESS_STREAMING)
    }

    private fun guessMimeType(path: String): String {
        return URLConnection.guessContentTypeFromName(path) ?: "text/plain"
    }

    override fun handle(path: String): WebResourceResponse? {
        return try {
            WebResourceResponse(guessMimeType(path), null, openAsset(path))
        } catch (e: IOException) {
            WebResourceResponse(null, null, null)
        }
    }
}

@Suppress("SpellCheckingInspection")
class MainActivity : AppCompatActivity() {
    private lateinit var host: IModelJsHost
    private var promiseName: String = ""
    private lateinit var env: JSONObject

    companion object {
        const val BIM_CACHE_DIR = "bim_cache"
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WebView.setWebContentsDebuggingEnabled(true)
        val alwaysExtractAssets = true // for debugging, otherwise the host will only extract when app version changes
        host = IModelJsHost(this, alwaysExtractAssets, true)
        host.startup()

        val webView = WebView(this)
        // using a WebViewAssetLoader so that the localization json files load properly
        // the version of i18next-http-backend we're using tries to use the fetch API with file URL's (apparently fixed in version 2.0.1)
        val assetLoader = WebViewAssetLoader.Builder().addPathHandler("/assets/", AssetsPathHandler(this)).build()

        webView.webViewClient = object : WebViewClientCompat() {
            override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest): WebResourceResponse? {
                return assetLoader.shouldInterceptRequest(request.url)
            }
        }

        val startPickDocument = registerForActivityResult(PickUriContract(BIM_CACHE_DIR)) { uri ->
            if (uri != null && promiseName.isNotEmpty()) {
                val js = "if (window.$promiseName) window.$promiseName(\"$uri\"); else console.log('Error: window.$promiseName is not defined!');"
                MainScope().launch {
                    webView.evaluateJavascript(js, null)
                }
            }
        }

        webView.addJavascriptInterface(
            object {
                @JavascriptInterface
                @Suppress("unused")
                fun openModel(promiseName: String) {
                    this@MainActivity.promiseName = promiseName
                    startPickDocument.launch(null)
                }

                @JavascriptInterface
                @Suppress("unused")
                fun modelOpened(modelName: String) {
                    println("iModel opened: $modelName")
                }
            }, "DTA_Android")

        host.webView = webView
        setContentView(webView)

        var args = "&standalone=true"
        loadEnvJson()
        env.optStringNotEmpty("IMJS_STANDALONE_FILENAME")?.let { fileName ->
            // ensure fileName already exists in the external files
            getExternalFilesDir(BIM_CACHE_DIR)?.let { filesDir ->
                val fullPath = File(filesDir, fileName)
                if (fullPath.exists())
                    args += "&iModelName=${Uri.encode(fullPath.toString())}"
            }
        }

        if (env.has("IMJS_IGNORE_CACHE"))
            args += "&ignoreCache=true"

        host.loadEntryPoint(env.optStringNotEmpty("IMJS_DEBUG_URL") ?: "https://${WebViewAssetLoader.DEFAULT_DOMAIN}/assets/frontend/index.html", args)
    }

    private fun loadEnvJson() {
        env = try {
            JSONObject(assets.open("env.json").bufferedReader().use { it.readText() })
        } catch (ex: Exception) {
            JSONObject()
        }
    }

    override fun onResume() {
        host.onResume()
        super.onResume()
    }

    override fun onPause() {
        host.onPause()
        super.onPause()
    }
}