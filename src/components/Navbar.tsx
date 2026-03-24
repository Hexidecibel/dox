import { AppBar, Toolbar, Typography, Button, Container, Box } from '@mui/material'
import { Link as RouterLink } from 'react-router-dom'

export function Navbar() {
  return (
    <AppBar position="static" color="transparent" elevation={0}>
      <Container maxWidth="lg">
        <Toolbar disableGutters>
          <Typography
            variant="h6"
            component={RouterLink}
            to="/"
            sx={{ textDecoration: 'none', color: 'inherit', flexGrow: 1 }}
          >
            doc-upload-site
          </Typography>
          <Box sx={{ display: 'flex', gap: 2 }}>
            <Button component={RouterLink} to="/" color="inherit">
              Home
            </Button>
            <Button component={RouterLink} to="/about" color="inherit">
              About
            </Button>
            <Button component={RouterLink} to="/contact" color="inherit">
              Contact
            </Button>
          </Box>
        </Toolbar>
      </Container>
    </AppBar>
  )
}