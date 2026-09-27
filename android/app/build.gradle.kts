import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Web assets live at the repo root (shared with the Chrome extension and the
// iPad wrapper). They are staged into build/generated/webroot/web/... so the
// app serves them from assets under https://chzzk.naver.com/__stellaview/.
val repoRoot = rootDir.parentFile
val webRoot = layout.buildDirectory.dir("generated/webroot")
val stageWebRoot by tasks.registering(Copy::class) {
    into(webRoot.map { it.dir("web") })
    from(repoRoot) {
        include("viewer.html", "viewer.css", "viewer.js", "background.js")
        include("src/shared/**")
        include("content/**")
    }
    // Wrapper-specific web files are kept with the iOS project but are shared.
    from(repoRoot.resolve("ios/Resources/ios-web")) {
        into("ios-web")
    }
}

// Release signing: android/keystore/release.jks + keystore.properties
// (storePassword, keyPassword, keyAlias). Both are git-ignored; without them
// the release build falls back to the debug key so a personal install still
// works, but updates then require the same debug keystore.
val keystoreProperties = Properties().apply {
    val file = rootProject.file("keystore/keystore.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}
val releaseKeystore = rootProject.file("keystore/release.jks")

android {
    namespace = "dev.siturasu.streammultiview"
    compileSdk = 35

    defaultConfig {
        applicationId = "dev.siturasu.streammultiview"
        minSdk = 31
        targetSdk = 35
        versionCode = 2
        versionName = "0.1.1"
    }

    signingConfigs {
        if (releaseKeystore.exists() && keystoreProperties.containsKey("storePassword")) {
            create("release") {
                storeFile = releaseKeystore
                storePassword = keystoreProperties.getProperty("storePassword")
                keyAlias = keystoreProperties.getProperty("keyAlias", "streammultiview")
                keyPassword = keystoreProperties.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
        debug {
            applicationIdSuffix = ""
        }
    }

    sourceSets["main"].assets.srcDir(webRoot)

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

tasks.named("preBuild") { dependsOn(stageWebRoot) }

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.webkit:webkit:1.13.0")
}
