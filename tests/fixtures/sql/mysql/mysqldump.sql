-- MySQL dump 10.13  Distrib 8.0.36, for Linux (x86_64)
--
-- Host: localhost    Database: bookshop
-- ------------------------------------------------------
-- Server version	8.0.36

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET NAMES utf8mb4 */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;

CREATE DATABASE /*!32312 IF NOT EXISTS*/ `bookshop` /*!40100 DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci */ /*!80016 DEFAULT ENCRYPTION='N' */;

USE `bookshop`;

--
-- Table structure for table `authors`
--

DROP TABLE IF EXISTS `authors`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `authors` (
  `author_id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(120) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Pen name, as printed on the cover',
  `born` date DEFAULT NULL,
  PRIMARY KEY (`author_id`),
  UNIQUE KEY `uq_author_name` (`name`)
) ENGINE=InnoDB AUTO_INCREMENT=3 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='People who write books';
/*!40101 SET character_set_client = @saved_cs_client */;

DROP TABLE IF EXISTS `books`;
CREATE TABLE `books` (
  `book_id` int unsigned NOT NULL AUTO_INCREMENT,
  `isbn` char(13) NOT NULL,
  `title` varchar(255) NOT NULL,
  `author_id` int NOT NULL,
  `price` decimal(8,2) NOT NULL DEFAULT '0.00',
  `status` enum('draft','live','retired') NOT NULL DEFAULT 'draft',
  `published_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`book_id`),
  UNIQUE KEY `isbn` (`isbn`),
  KEY `idx_books_author` (`author_id`),
  FULLTEXT KEY `ft_title` (`title`),
  CONSTRAINT `fk_books_author` FOREIGN KEY (`author_id`) REFERENCES `authors` (`author_id`) ON DELETE CASCADE ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

DROP TABLE IF EXISTS `sales`;
CREATE TABLE `sales` (
  `sale_id` bigint NOT NULL AUTO_INCREMENT,
  `book_id` int unsigned NOT NULL,
  `qty` smallint NOT NULL DEFAULT '1',
  `sold_on` date NOT NULL,
  PRIMARY KEY (`sale_id`),
  KEY `book_id` (`book_id`),
  CONSTRAINT `sales_ibfk_1` FOREIGN KEY (`book_id`) REFERENCES `books` (`book_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

LOCK TABLES `authors` WRITE;
/*!40000 ALTER TABLE `authors` DISABLE KEYS */;
INSERT INTO `authors` VALUES (1,'Ursula K. Le Guin','1929-10-21'),(2,'It''s a \'quoted\' name; really',NULL);
/*!40000 ALTER TABLE `authors` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Temporary view structure for view `revenue_per_author`
--

DROP TABLE IF EXISTS `revenue_per_author`;
/*!50001 DROP VIEW IF EXISTS `revenue_per_author`*/;
SET @saved_cs_client     = @@character_set_client;
/*!50503 SET character_set_client = utf8mb4 */;
/*!50001 CREATE VIEW `revenue_per_author` AS SELECT
 1 AS `name`,
 1 AS `revenue`*/;

/*!50001 DROP VIEW IF EXISTS `revenue_per_author`*/;
/*!50001 CREATE ALGORITHM=UNDEFINED */
/*!50013 DEFINER=`root`@`localhost` SQL SECURITY DEFINER */
/*!50001 VIEW `revenue_per_author` AS select `a`.`name` AS `name`,sum((`s`.`qty` * `b`.`price`)) AS `revenue` from ((`sales` `s` join `books` `b` on((`b`.`book_id` = `s`.`book_id`))) join `authors` `a` on((`a`.`author_id` = `b`.`author_id`))) group by `a`.`name` */;

DELIMITER ;;
CREATE DEFINER=`root`@`localhost` TRIGGER `books_bi` BEFORE INSERT ON `books` FOR EACH ROW BEGIN
  SET NEW.title = TRIM(NEW.title);
  IF NEW.price < 0 THEN SET NEW.price = 0; END IF;
END ;;
CREATE DEFINER=`root`@`localhost` PROCEDURE `top_books`(IN n INT)
BEGIN
  SELECT title FROM books ORDER BY price DESC LIMIT n;
END ;;
DELIMITER ;

/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
-- Dump completed on 2024-03-01 10:00:00
