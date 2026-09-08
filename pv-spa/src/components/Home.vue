<template>
  <section
    class="relative overflow-hidden rounded-b-2xl min-h-[65vh] flex items-center justify-center text-center -mx-2 sm:-mx-4 -mt-4 sm:-mt-6"
  >
    <div
      v-if="heroThumbs.length"
      class="absolute inset-0 grid grid-cols-4 sm:grid-cols-6 gap-1"
    >
      <img
        v-for="(src, i) in heroThumbs"
        :key="i"
        :src="src"
        alt=""
        loading="lazy"
        class="w-full h-full object-cover"
      />
    </div>

    <div
      class="absolute inset-0"
      :class="
        heroThumbs.length
          ? 'bg-gradient-to-b from-black/50 via-black/60 to-gray-50'
          : 'bg-gradient-to-b from-blue-900/20 to-gray-50'
      "
    ></div>

    <div class="relative z-10 px-4 py-24">
      <h1
        class="text-5xl sm:text-6xl font-bold mb-4"
        :class="
          heroThumbs.length
            ? 'text-white'
            : 'bg-gradient-to-br from-blue-500 to-blue-700 bg-clip-text text-transparent'
        "
      >
        EKSKOG GALLERY
      </h1>
      <p
        class="text-lg sm:text-xl mb-8 max-w-xl mx-auto"
        :class="heroThumbs.length ? 'text-gray-100' : 'text-gray-600'"
      >
        Your photos, organized and always within reach.
      </p>
      <div class="flex gap-4 justify-center flex-wrap">
        <button
          class="px-6 py-3 rounded-md bg-blue-600 hover:bg-blue-700 text-white font-semibold shadow-md transition"
          @click="$emit('login')"
        >
          Log In
        </button>
        <button
          class="px-6 py-3 rounded-md bg-white/90 hover:bg-white text-gray-800 font-semibold shadow-md transition"
          @click="$emit('register')"
        >
          Create Account
        </button>
      </div>
    </div>
  </section>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import apiService from '../services/api.js'

defineEmits(['login', 'register'])

const heroThumbs = ref([])

// ponytail: stops at the first album that has thumbnails; if the gallery
// grows a lot of empty albums this becomes a slow scan — swap for a
// dedicated "sample photos" endpoint if that happens.
onMounted(async () => {
  try {
    const { albums = [] } = await apiService.getAlbums()
    for (const album of albums) {
      const res = await apiService.getAlbumContents(album.name)
      const objects = res?.album?.objects || res?.objects || []
      const thumbs = objects.map((o) => o.thumbnailUrl).filter(Boolean)
      if (thumbs.length) {
        heroThumbs.value = thumbs.slice(0, 12)
        break
      }
    }
  } catch {
    // silent fallback to the gradient-only hero
  }
})
</script>
