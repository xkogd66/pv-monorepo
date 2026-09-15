<template>
  <div class="max-w-[1200px] mx-auto px-4 py-8">
    <!-- Toolbar: pinned under the 64px app header while the grid scrolls (same
         sticky pattern as AlbumHeader.vue). -mx-4/px-4 lets its gray-50 background
         span the container padding so cards never show through beside it. -->
    <div class="sticky top-16 z-20 -mx-4 px-4 pt-2 pb-3 mb-6 sm:mb-7 bg-gray-50 border-b border-gray-200 flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
      <div class="flex items-end justify-between gap-4">
        <div class="min-w-0">
          <h1 class="text-2xl font-semibold tracking-tight text-gray-900">Albums</h1>
          <p class="mt-1.5 text-xs sm:text-sm text-gray-500 tabular-nums">{{ summaryLine }}</p>
        </div>
        <!-- Create: icon-only on phone, labelled from sm up -->
        <button v-if="canCreateAlbum" @click="showCreateDialog = true" title="New album"
          class="sm:hidden flex-none w-11 h-11 flex items-center justify-center bg-emerald-600 text-white rounded-lg transition hover:bg-emerald-700">
          <i class="fas fa-plus"></i>
        </button>
      </div>

      <div class="flex items-center gap-2">
        <select
          v-if="!loading && !error && availableYears.length > 0"
          v-model="selectedYear"
          title="Filter albums by year"
          class="flex-1 sm:flex-none min-w-0 h-11 sm:h-[34px] px-2.5 text-sm sm:text-[13px] border border-gray-200 rounded-lg sm:rounded-md bg-white text-gray-700 focus:outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-200"
        >
          <option :value="null">All years</option>
          <option v-for="y in availableYears" :key="y" :value="y">{{ y }}</option>
        </select>

        <select
          v-if="!loading && !error && albums.length > 0"
          v-model="sortOrder"
          title="Sort albums"
          class="flex-1 sm:flex-none min-w-0 h-11 sm:h-[34px] px-2.5 text-sm sm:text-[13px] border border-gray-200 rounded-lg sm:rounded-md bg-white text-gray-700 focus:outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-200"
        >
          <option value="year-desc">Newest first</option>
          <option value="year-asc">Oldest first</option>
          <option value="modified-desc">Recently modified</option>
          <option value="modified-asc">Least recently modified</option>
          <option value="name-asc">Name A&ndash;Z</option>
          <option value="name-desc">Name Z&ndash;A</option>
        </select>

        <button @click="refreshAlbums" :disabled="loading" title="Refresh albums"
          class="flex-none w-11 h-11 sm:w-[34px] sm:h-[34px] flex items-center justify-center border border-gray-200 rounded-lg sm:rounded-md bg-white text-gray-600 text-[13px] transition hover:bg-gray-50 disabled:opacity-60 disabled:cursor-not-allowed">
          <i class="fas fa-sync-alt" :class="{ 'fa-spin': loading }"></i>
        </button>

        <button v-if="canCreateAlbum" @click="showCreateDialog = true"
          class="hidden sm:flex items-center h-[34px] px-3.5 bg-emerald-600 text-white rounded-md text-[13px] font-semibold transition hover:bg-emerald-700 whitespace-nowrap">
          <i class="fas fa-plus mr-1.5"></i>New album
        </button>
      </div>
    </div>

    <!-- Loading State -->
    <div v-if="loading" class="text-center py-12">
      <div class="w-10 h-10 border-4 border-gray-200 border-t-emerald-500 rounded-full animate-spin mx-auto mb-4"></div>
      <p>Loading albums...</p>
    </div>

    <!-- Error State -->
    <div v-if="error" class="text-center py-8 text-red-500">
      <p><i class="fas fa-exclamation-triangle"></i> {{ error }}</p>
      <button @click="loadAlbums"
        class="mt-4 bg-gray-100 text-gray-800 border border-gray-300 px-4 py-3 rounded-md text-sm transition hover:bg-gray-200">
        Try Again
      </button>
    </div>

    <!-- Albums Grid -->
    <div v-if="!loading && !error">
      <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-x-4 gap-y-5 sm:gap-x-6 sm:gap-y-8">
        <AlbumCard
          v-for="album in visibleAlbums"
          :key="album.name"
          :album="album"
          :can-rename="canRenameAlbum"
          :can-delete="canDeleteAlbum"
          @click="openAlbum"
          @rename="openEditDialog"
          @delete="confirmDelete"
        />
        <!-- Empty State (no albums at all, or no albums match the active year filter) -->
        <div v-if="albums.length === 0 || (selectedYear != null && filteredAlbums.length === 0)" class="col-span-full text-center py-16 px-8">
          <div class="text-5xl mb-4 text-gray-400"><i class="fas fa-camera"></i></div>
          <h3 class="text-xl text-gray-800 mb-4">
            {{ selectedYear != null && filteredAlbums.length === 0 ? `No Albums in ${selectedYear}` : 'No Albums Yet' }}
          </h3>
          <p class="text-gray-600 mb-6">
            <template v-if="selectedYear != null && filteredAlbums.length === 0">
              No albums match this year. Try another year or clear the filter.
            </template>
            <template v-else>
              <span v-if="canCreateAlbum">Create your first photo album to get started!</span>
              <span v-else>No albums available to view.</span>
            </template>
          </p>
          <button v-if="canCreateAlbum" @click="showCreateDialog = true"
            class="bg-emerald-500 text-white px-6 py-3 rounded-md text-sm font-semibold shadow-md transition hover:bg-emerald-600">
            <i class="fas fa-plus mr-2"></i>Create Album
          </button>
        </div>
      </div>

      <!-- Infinite scroll sentinel — always in DOM (v-show, not v-if) so the
           observer's element reference stays stable across batches. -->
      <div
        ref="scrollTrigger"
        v-show="hasMoreAlbums"
        class="h-12 flex items-center justify-center"
      >
        <svg v-if="isLoadingMore" class="animate-spin h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="m4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
        </svg>
      </div>
    </div>

    <!-- Create Album Dialog -->
    <CreateAlbumDialog 
      :visible="showCreateDialog" 
      :creating="creating" 
      @create="handleCreateAlbum" 
      @close="closeCreateDialog" 
    />

    <!-- Delete Confirmation Dialog -->
    <div v-if="showDeleteDialog" class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[1000]"
      @click="closeDeleteDialog">
      <div class="bg-white rounded-xl p-8 w-full max-w-md shadow-xl mx-4" @click.stop>
        <h3 class="text-lg font-semibold text-gray-800 mb-4">Delete Album</h3>
        <p class="mb-4">Are you sure you want to delete the album "<strong>{{ getAlbumDisplayName(albumToDelete?.name)
        }}</strong>"?</p>
        <p class="text-orange-600 text-sm mb-6 bg-orange-50 p-3 rounded-md">
          <i class="fas fa-exclamation-triangle mr-2"></i>This action cannot be undone and will delete all photos in this album.
        </p>
        <div class="flex justify-end gap-4 flex-wrap sm:flex-nowrap">
          <button @click="closeDeleteDialog"
            class="bg-gray-100 text-gray-800 border border-gray-300 px-4 py-3 rounded-md text-sm transition hover:bg-gray-200 min-w-[80px]">
            Cancel
          </button>
          <button @click="deleteAlbum" :disabled="deleting"
            class="bg-red-500 text-white px-4 py-3 rounded-md text-sm font-semibold transition hover:bg-red-600 disabled:opacity-60 disabled:cursor-not-allowed min-w-[120px]">
            {{ deleting ? 'Deleting...' : 'Delete Album' }}
          </button>
        </div>
      </div>
    </div>

    <!-- Edit Album Dialog -->
    <div v-if="showEditDialog" class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[1000]"
      @click="closeEditDialog">
      <div class="bg-white rounded-xl p-8 w-full max-w-md shadow-xl mx-4" @click.stop>
        <h3 class="text-lg font-semibold text-gray-800 mb-4">Edit Album</h3>
        <p class="mb-4">Edit "<strong>{{ getAlbumDisplayName(albumToEdit?.name) }}</strong>".</p>
        <div class="mb-6">
          <label for="editAlbumName" class="block mb-2 font-medium text-gray-800">Album Name:</label>
          <input id="editAlbumName" v-model="editAlbumName" type="text" placeholder="Enter album name..."
            @keyup.enter="saveAlbum" ref="editAlbumNameInput"
            class="w-full px-4 py-3 border border-gray-300 rounded-md text-base focus:outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-200" />
        </div>
        <div class="mb-6">
          <label for="editAlbumDescription" class="block mb-2 font-medium text-gray-800">Description (optional):</label>
          <textarea id="editAlbumDescription" v-model="editAlbumDescription" placeholder="Enter album description..."
            rows="3"
            class="w-full px-4 py-3 border border-gray-300 rounded-md text-base focus:outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-200 resize-none"></textarea>
        </div>
        <div class="mb-6">
          <label for="editAlbumMonth" class="block mb-2 font-medium text-gray-800">Month:</label>
          <select id="editAlbumMonth" v-model="editAlbumMonth"
            class="w-full px-4 py-3 border border-gray-300 rounded-md text-base focus:outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-200">
            <option value="">Select month...</option>
            <option value="01">January</option>
            <option value="02">February</option>
            <option value="03">March</option>
            <option value="04">April</option>
            <option value="05">May</option>
            <option value="06">June</option>
            <option value="07">July</option>
            <option value="08">August</option>
            <option value="09">September</option>
            <option value="10">October</option>
            <option value="11">November</option>
            <option value="12">December</option>
          </select>
        </div>
        <div class="mb-6">
          <label for="editAlbumYear" class="block mb-2 font-medium text-gray-800">Year:</label>
          <input id="editAlbumYear" v-model="editAlbumYear" type="number" placeholder="Enter year (e.g., 2025)" min="1900" max="2100"
            class="w-full px-4 py-3 border border-gray-300 rounded-md text-base focus:outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-200" />
        </div>
        <div class="mb-6">
          <label class="flex items-center gap-2 text-gray-800">
            <input id="editAlbumPrivate" v-model="editAlbumPrivate" type="checkbox" class="w-4 h-4" />
            Private (hidden from anonymous visitors)
          </label>
        </div>
        <div class="flex justify-end gap-4 flex-wrap sm:flex-nowrap">
          <button @click="closeEditDialog"
            class="bg-gray-100 text-gray-800 border border-gray-300 px-4 py-3 rounded-md text-sm transition hover:bg-gray-200 min-w-[80px]">
            Cancel
          </button>
          <button @click="saveAlbum" :disabled="!editAlbumName.trim() || saving"
            class="bg-emerald-500 text-white px-4 py-3 rounded-md text-sm font-semibold shadow-md transition hover:bg-emerald-600 disabled:opacity-60 disabled:cursor-not-allowed min-w-[120px]">
            {{ saving ? 'Saving...' : 'Save Changes' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, nextTick, watch, computed } from 'vue'
import apiService from '../services/api.js'
import authService from '../services/auth.js'
import CreateAlbumDialog from './CreateAlbumDialog.vue'
import AlbumCard from './AlbumCard.vue'

// Emits
const emit = defineEmits(['navigate', 'openAlbum'])

// Reactive state
const loading = ref(false)
const error = ref(null)
const albums = ref([])
const showCreateDialog = ref(false)
const showDeleteDialog = ref(false)
const showEditDialog = ref(false)
const editAlbumName = ref('')
const editAlbumDescription = ref('')
const editAlbumMonth = ref('')
const editAlbumYear = ref('')
const editAlbumPrivate = ref(true)
const creating = ref(false)
const deleting = ref(false)
const saving = ref(false)
const albumToDelete = ref(null)
const albumToEdit = ref(null)
const editAlbumNameInput = ref(null)
const sortOrder = ref('year-desc')
const selectedYear = ref(null)

// Infinite scroll: how many albums of `sortedAlbums` are currently rendered.
// The full album list is fetched once (see loadAlbums) — growing this number is
// a synchronous slice, so scrolling never hits the network.
const ITEMS_PER_PAGE = 24
const visibleCount = ref(ITEMS_PER_PAGE)
const isLoadingMore = ref(false)
// Distinct years across all albums (most recent first) — drives the year filter dropdown
const availableYears = computed(() => {
  const years = new Set(
    albums.value
      .map((album) => album.year)
      .filter((y) => typeof y === 'number' && Number.isInteger(y))
  );
  return [...years].sort((a, b) => b - a);
});

// Albums filtered by the selected year (null = all years)
const filteredAlbums = computed(() => {
  if (selectedYear.value == null) return albums.value;
  return albums.value.filter((album) => album.year === selectedYear.value);
});

// Header summary — counts what the year filter is actually showing
const summaryLine = computed(() => {
  const count = filteredAlbums.value.length;
  const photos = filteredAlbums.value.reduce((sum, a) => sum + (a.fileCount || 0), 0);
  return `${count} ${count === 1 ? 'album' : 'albums'} · ${photos.toLocaleString()} photos`;
});

// Albums with a missing value always sort last, in both directions.
const compareYearMonth = (a, b, dir) => {
  const aHasYear = a.year != null
  const bHasYear = b.year != null
  if (aHasYear !== bHasYear) return aHasYear ? -1 : 1
  if (!aHasYear) return 0 // neither dated — keep stable order
  if (a.year !== b.year) return dir * (a.year - b.year)

  const aHasMonth = a.month != null
  const bHasMonth = b.month != null
  if (aHasMonth !== bHasMonth) return aHasMonth ? -1 : 1
  if (!aHasMonth) return 0
  return dir * (a.month - b.month)
}

const compareModified = (a, b, dir) => {
  const at = a.lastModified ? new Date(a.lastModified).getTime() : null
  const bt = b.lastModified ? new Date(b.lastModified).getTime() : null
  if (at == null && bt == null) return 0
  if (at == null) return 1
  if (bt == null) return -1
  return dir * (at - bt)
}

// Computed property for sorted albums (sorts within the year-filtered set).
// `dir` is -1 for a `-desc` option, +1 for `-asc`, so each pair shares one comparator.
const sortedAlbums = computed(() => {
  const dir = sortOrder.value.endsWith('-desc') ? -1 : 1
  return [...filteredAlbums.value].sort((a, b) => {
    switch (sortOrder.value) {
      case 'year-desc':
      case 'year-asc':
        return compareYearMonth(a, b, dir)
      case 'modified-desc':
      case 'modified-asc':
        return compareModified(a, b, dir)
      case 'name-asc':
        return a.name.localeCompare(b.name)
      case 'name-desc':
        return b.name.localeCompare(a.name)
      default:
        return 0
    }
  })
})

// Albums currently rendered — a window that only ever grows as the user scrolls
const visibleAlbums = computed(() => {
  return sortedAlbums.value.slice(0, visibleCount.value)
})

const hasMoreAlbums = computed(() => {
  return visibleCount.value < sortedAlbums.value.length
})

const loadMore = () => {
  if (isLoadingMore.value || !hasMoreAlbums.value) return
  isLoadingMore.value = true
  visibleCount.value = Math.min(
    visibleCount.value + ITEMS_PER_PAGE,
    sortedAlbums.value.length
  )
  isLoadingMore.value = false
}

// Observer on the sentinel at the bottom of the grid. The sentinel uses v-show,
// not v-if: v-if would destroy and recreate the element on each batch, breaking
// the DOM reference the observer holds.
const scrollTrigger = ref(null)
let observer = null

const setupObserver = () => {
  if (!scrollTrigger.value) return
  observer = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting && hasMoreAlbums.value && !isLoadingMore.value) {
      loadMore()
    }
  }, { rootMargin: '200px' })
  observer.observe(scrollTrigger.value)
}

const teardownObserver = () => {
  observer?.disconnect()
  observer = null
}

// Computed properties for permission checks
const canCreateAlbum = computed(() => {
  return authService.canPerformAction('create_album')
})

const canDeleteAlbum = computed(() => {
  return authService.canPerformAction('delete_album')
})

const canRenameAlbum = computed(() => {
  return authService.canPerformAction('delete_album')
})

// Constants
const BUCKET_NAME = 'photovault'

// Methods
const loadAlbums = async () => {
  loading.value = true
  error.value = null

  try {
    const response = await apiService.getAlbums()

    if (response.success && response.albums) {
      const albumsWithDates = response.albums.map((album) => {
        return {
          name: album.name,
          lastModified: album.updated_at 
            ? new Date(album.updated_at).toISOString() 
            : null,
          fileCount: album.fileCount ?? 0,
          year: album.year ?? null,
          month: album.month ?? null,
          description: album.description ?? '',
          coverThumbnailUrl: album.coverThumbnailUrl ?? null,
          isPrivate: album.isPrivate ?? false,

        }
      })

      albums.value = albumsWithDates
      // The list was just replaced wholesale — rewind to the first batch. A
      // preserved scroll position would point at whatever slid into that slot,
      // and after a create/edit/delete the ordering itself may have changed.
      visibleCount.value = ITEMS_PER_PAGE
    } else {
      throw new Error(response.error || 'Failed to load albums - API returned unsuccessful response')
    }
  } catch (err) {
    console.error('[ALBUMS ERROR]', err)
    error.value = `Error loading albums: ${err.message}. Check browser console for details.`
  } finally {
    loading.value = false
  }
}

const handleCreateAlbum = async (albumData) => {
  if (!authService.canPerformAction('create_album')) {
    error.value = 'You do not have permission to create albums'
    return
  }

  creating.value = true
  error.value = null

  try {
    const response = await apiService.createFolder(albumData.name, albumData.description, albumData.month, albumData.year, albumData.isPrivate)

    if (response.success) {
      closeCreateDialog()
      await loadAlbums()
    } else {
      throw new Error(response.error || 'Failed to create album')
    }
  } catch (err) {
    console.error('[ALBUMS ERROR]', err)
    error.value = `Failed to create album: ${err.message}`
  } finally {
    creating.value = false
  }
}

const closeCreateDialog = () => {
  showCreateDialog.value = false
  creating.value = false
}

const confirmDelete = (album) => {
  if (!authService.canPerformAction('delete_album')) {
    error.value = 'You do not have permission to delete albums'
    return
  }

  albumToDelete.value = album
  showDeleteDialog.value = true
}

const deleteAlbum = async () => {
  if (!albumToDelete.value) return

  deleting.value = true
  error.value = null

  try {
    const response = await apiService.deleteFolder(BUCKET_NAME, albumToDelete.value.name)

    if (response.success) {
      await loadAlbums()
      closeDeleteDialog()
    } else {
      throw new Error(response.error || 'Failed to delete album')
    }
  } catch (err) {
    console.error('[ALBUMS ERROR]', err)
    error.value = `Failed to delete album: ${err.message}`
  } finally {
    deleting.value = false
  }
}

const openEditDialog = (album) => {
  if (!authService.canPerformAction('delete_album')) {
    error.value = 'You do not have permission to edit albums'
    return
  }

  albumToEdit.value = album
  editAlbumName.value = album.name
  editAlbumDescription.value = album.description || ''
  editAlbumMonth.value = album.month ? String(album.month).padStart(2, '0') : ''
  editAlbumYear.value = album.year ? String(album.year) : ''
  editAlbumPrivate.value = album.isPrivate ?? true
  showEditDialog.value = true
}

const saveAlbum = async () => {
  if (!albumToEdit.value || !editAlbumName.value.trim()) return

  saving.value = true
  error.value = null

  try {
    const changes = {
      newName: editAlbumName.value.trim(),
      description: editAlbumDescription.value.trim() || null,
      month: editAlbumMonth.value ? parseInt(editAlbumMonth.value, 10) : null,
      year: editAlbumYear.value ? parseInt(editAlbumYear.value, 10) : null,
      isPrivate: editAlbumPrivate.value,
    }

    const response = await apiService.updateAlbum(albumToEdit.value.name, changes)

    if (response.success) {
      await loadAlbums()
      closeEditDialog()
    } else {
      throw new Error(response.error || 'Failed to update album')
    }
  } catch (err) {
    console.error('[ALBUMS ERROR]', err)
    error.value = `Failed to update album: ${err.message}`
  } finally {
    saving.value = false
  }
}

const openAlbum = (album) => {
  emit('openAlbum', album)
}

const closeDeleteDialog = () => {
  showDeleteDialog.value = false
  albumToDelete.value = null
  deleting.value = false
}

const closeEditDialog = () => {
  showEditDialog.value = false
  albumToEdit.value = null
  editAlbumName.value = ''
  editAlbumDescription.value = ''
  editAlbumMonth.value = ''
  editAlbumYear.value = ''
  editAlbumPrivate.value = true
  saving.value = false
}

const getAlbumDisplayName = (folderName) => {
  return folderName.replace(/\.+/g, ' ')
}

const refreshAlbums = async () => {
  await loadAlbums()
}

const focusEditInput = async () => {
  await nextTick()
  if (editAlbumNameInput.value) {
    editAlbumNameInput.value.focus()
    editAlbumNameInput.value.select()
  }
}

watch(showEditDialog, (newVal) => {
  if (newVal) {
    focusEditInput()
  }
})

watch(sortOrder, () => {
  visibleCount.value = ITEMS_PER_PAGE
})

watch(selectedYear, () => {
  visibleCount.value = ITEMS_PER_PAGE
})

// Lifecycle
onMounted(() => {
  loadAlbums()
  setupObserver()
})

onUnmounted(teardownObserver)
</script>

<style scoped>
button {
  min-height: 44px;
}

.transition {
  transition: all 0.2s ease-in-out;
}
</style>