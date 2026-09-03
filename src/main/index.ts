import { app } from 'electron'
app.whenReady().then(() => {
  console.log('mechanicus-buddy boot')
  app.quit()
})
