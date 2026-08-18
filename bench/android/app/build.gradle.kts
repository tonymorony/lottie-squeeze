plugins { id("com.android.application") }
android {
    namespace = "bench.lottie"
    compileSdk = 35
    defaultConfig { applicationId = "bench.lottie"; minSdk = 24; targetSdk = 35; versionCode = 1; versionName = "1" }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    buildTypes { release { isMinifyEnabled = false } }
}
dependencies { implementation("com.airbnb.android:lottie:6.6.7") }
